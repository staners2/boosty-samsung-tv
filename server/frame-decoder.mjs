import {spawn} from 'node:child_process';
import {openMediaSource} from './media-source.mjs';
import {AppError} from './errors.mjs';

export const decoderKillGraceMs = 500;
const unavailable = code => new AppError(code === 'preview_cancelled' ? 499 : 502, code, 'error_post_missing_23');

export async function extractFrame({sourceUrl, userAgent, seconds, signal, maxBytes}, {
  openSource = openMediaSource, spawnProcess = spawn, ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
} = {}) {
  let source, child, killTimer, abort, failure, stopping = false;
  try {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 65536) throw unavailable('preview_unavailable');
    if (signal?.aborted) throw unavailable('preview_cancelled');
    source = await openSource({url: sourceUrl, userAgent, signal});
    if (signal?.aborted) throw unavailable('preview_cancelled');
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-filter_threads', '1',
      '-protocol_whitelist', 'http,tcp', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0',
      '-ss', String(seconds), '-accurate_seek', '-i', source.url,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
      '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-threads', '1', '-q:v', '4', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
    ];
    child = spawnProcess(ffmpegPath, args, {shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    const chunks = []; let length = 0;
    const stop = error => {
      failure ??= error;
      if (stopping) return;
      stopping = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), decoderKillGraceMs);
    };
    abort = () => stop(unavailable('preview_cancelled'));
    const closed = new Promise(resolve => {
      child.once('error', () => {failure ??= unavailable('preview_decoder');});
      child.once('close', code => {clearTimeout(killTimer); resolve(code);});
    });
    child.stdout.on('data', chunk => {
      if (stopping) return;
      length += chunk.length;
      if (length > maxBytes) {stop(unavailable('preview_unavailable')); return;}
      chunks.push(chunk);
    });
    child.stderr.resume();
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const exitCode = await closed;
    if (failure) throw failure;
    const frame = Buffer.concat(chunks, length);
    if (exitCode !== 0 || frame.length < 4 || frame.readUInt16BE(0) !== 0xffd8
      || frame.readUInt16BE(frame.length-2) !== 0xffd9) throw unavailable('preview_unavailable');
    return frame;
  } catch (error) {
    if (signal?.aborted) throw unavailable('preview_cancelled');
    if (error instanceof AppError) throw error;
    throw unavailable('preview_decoder');
  } finally {
    clearTimeout(killTimer); if (abort) signal?.removeEventListener('abort', abort);
    child?.stdout.destroy(); child?.stderr.destroy(); await source?.close();
  }
}
