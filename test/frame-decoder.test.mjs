import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractFrame, decoderKillGraceMs} from '../server/frame-decoder.mjs';

const jpeg = Buffer.from([255,216,255,217]);
const selection = {sourceUrl: 'https://vd580.okcdn.ru/a.mp4', userAgent: 'test-TV', seconds: 90, maxBytes: 65536};
function processDouble({output = jpeg, code = 0, stalled = false, error} = {}) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const kills = []; let closed = 0;
  child.kill = signal => {kills.push(signal); return true;};
  return {child, kills, closes: () => closed, openSource: async () => ({url: 'http://127.0.0.1:12345/task-key', close: async () => {closed++;}}),
    spawnProcess(_file, args, options) {
      assert.equal(options.shell, false); assert.equal(args.includes(selection.sourceUrl), false);
      assert.equal(args[args.indexOf('-ss')+1], '90');
      assert.equal(args[args.indexOf('-protocol_whitelist')+1], 'http,tcp');
      assert.equal(args[args.indexOf('-enable_drefs')+1], '0');
      assert.equal(args[args.indexOf('-use_absolute_path')+1], '0');
      queueMicrotask(() => {
        child.stderr.write('https://signed.example/secret?token=do-not-print');
        if (error) child.emit('error', Object.assign(new Error('secret decoder path'), {code: 'ENOENT'}));
        if (!stalled) {child.stdout.end(output); child.emit('close', code);}
      });
      return child;
    }};
}

test('decoder returns one bounded JPEG and never exposes signed URLs or stderr', async () => {
  const dependencies = processDouble(); assert.deepEqual(await extractFrame(selection, dependencies), jpeg);
  assert.equal(dependencies.closes(), 1);
  for (const options of [{output: Buffer.alloc(0)}, {output: Buffer.from('not jpeg')}, {code: 1}, {error: true, code: -2}]) {
    const dependencies = processDouble(options);
    await assert.rejects(extractFrame(selection, dependencies), error => /^preview_/.test(error.code) && !/secret|signed/.test(error.message));
    assert.equal(dependencies.closes(), 1);
  }
});

test('abort waits for child close, then kills a stuck decoder after the bounded grace', async () => {
  const dependencies = processDouble({stalled: true}); const controller = new AbortController(); let settled = false;
  const result = extractFrame({...selection, signal: controller.signal}, dependencies).catch(error => {settled = true; throw error;});
  const checked = assert.rejects(result, {code: 'preview_cancelled'});
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(dependencies.kills, ['SIGTERM']); assert.equal(settled, false);
  await new Promise(resolve => setTimeout(resolve, decoderKillGraceMs+30));
  assert.deepEqual(dependencies.kills, ['SIGTERM', 'SIGKILL']); assert.equal(settled, false);
  dependencies.child.emit('close', null, 'SIGKILL'); await checked;
  assert.equal(dependencies.closes(), 1);
});

test('oversized stdout terminates the child without retaining the payload', async () => {
  const dependencies = processDouble({stalled: true});
  const result = extractFrame(selection, dependencies); const checked = assert.rejects(result, {code: 'preview_unavailable'});
  await new Promise(resolve => setImmediate(resolve)); dependencies.child.stdout.write(Buffer.alloc(65537));
  assert.deepEqual(dependencies.kills, ['SIGTERM']); dependencies.child.emit('close', 1); await checked;
  assert.equal(dependencies.closes(), 1);
});

test('abort during source opening closes the source without spawning a decoder', async () => {
  const controller = new AbortController(); const dependencies = processDouble(); let finish, spawns = 0;
  dependencies.openSource = () => new Promise(resolve => {finish = () => resolve({url: 'http://127.0.0.1:1/task', close: async () => {spawns++;}});});
  dependencies.spawnProcess = () => {throw new Error('must not spawn');};
  const result = extractFrame({...selection, signal: controller.signal}, dependencies);
  controller.abort(); finish(); await assert.rejects(result, {code: 'preview_cancelled'}); assert.equal(spawns, 1);
});

test('real FFmpeg seeks to the selected frame, not to an arbitrary poster or keyframe', async t => {
  const run = promisify(execFile); const directory = await mkdtemp(join(tmpdir(), 'boosty-preview-')); t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'colors.mp4');
  await run('ffmpeg', ['-hide_banner','-loglevel','error','-nostdin','-f','lavfi','-i','color=c=red:s=160x90:r=25:d=2',
    '-f','lavfi','-i','color=c=blue:s=160x90:r=25:d=2','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map','[v]','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',path]);
  const bytes = await readFile(path);
  const server = createServer((request, response) => {
    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), bytes.length-1) : bytes.length-1;
    if (start >= bytes.length) {response.writeHead(416, {'content-range': `bytes */${bytes.length}`}); response.end(); return;}
    response.writeHead(match ? 206 : 200, {'content-type': 'video/mp4', 'content-length': end-start+1, 'accept-ranges': 'bytes',
      ...(match ? {'content-range': `bytes ${start}-${end}/${bytes.length}`} : {})}); response.end(bytes.subarray(start,end+1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const openSource = async () => ({url: `http://127.0.0.1:${server.address().port}/colors.mp4`, close: async () => {}});
  const channels = [];
  for (const seconds of [0,2.5]) {
    const frame = await extractFrame({...selection, seconds, signal: AbortSignal.timeout(10000)}, {openSource});
    const child = (await import('node:child_process')).spawn('ffmpeg', ['-hide_banner','-loglevel','error','-i','pipe:0','-vf','scale=1:1','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    const chunks = []; child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.resume(); child.stdin.end(frame);
    assert.equal(await new Promise(resolve => child.on('close', resolve)), 0);
    channels.push(Buffer.concat(chunks));
  }
  assert.ok(channels[0][0]-channels[0][2] > 100); assert.ok(channels[1][2]-channels[1][0] > 100);
  await assert.rejects(extractFrame({...selection, seconds: 4, signal: AbortSignal.timeout(10000)}, {openSource}), {code: 'preview_unavailable'});
});
