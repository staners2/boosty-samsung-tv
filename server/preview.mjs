import {extractFrame, decoderKillGraceMs} from './frame-decoder.mjs';
import {selectPreviewSource} from './models.mjs';
import {AppError} from './errors.mjs';

export const previewLimits = Object.freeze({timeoutMs: 10000, maxFrameBytes: 65536,
  maxCacheBytes: 4194304, maxEntries: 128, ttlMs: 300000});
const cancelled = () => new AppError(499, 'preview_cancelled', 'error_post_missing_23');

export class PreviewService {
  #decode; #now; #timeout; #active; #pending; #closed = false;
  #cache = new Map(); #bytes = 0;
  constructor({decodeFrame = extractFrame, now = Date.now, timeoutMs = previewLimits.timeoutMs} = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= decoderKillGraceMs) throw new Error('Preview deadline must reserve decoder cleanup time');
    this.#decode = decodeFrame; this.#now = now; this.#timeout = timeoutMs;
  }
  get(selection, loadVideo) {
    if (this.#closed || selection.signal?.aborted) return Promise.reject(cancelled());
    if (this.#pending && this.#pending.selection.sessionKey !== selection.sessionKey) {
      return Promise.reject(new AppError(429, 'preview_busy', 'error_preview_busy_49'));
    }
    const controller = new AbortController();
    let resolve, reject, released;
    const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
    const done = new Promise(yes => {released = yes;});
    const job = {selection, loadVideo, controller, resolve, reject, done, released};
    job.abort = () => this.#cancel(job, cancelled());
    job.timer = setTimeout(() => this.#cancel(job, new AppError(504, 'preview_timeout', 'error_post_missing_23')), this.#timeout-decoderKillGraceMs);
    selection.signal?.addEventListener('abort', job.abort, {once: true});
    if (this.#pending) this.#cancel(this.#pending, cancelled());
    if (this.#active) {
      this.#pending = job;
      if (this.#active.selection.sessionKey === selection.sessionKey) this.#cancel(this.#active, cancelled());
    } else void this.#run(job);
    return promise;
  }
  #finish(job) {
    clearTimeout(job.timer); job.selection.signal?.removeEventListener('abort', job.abort); job.released();
  }
  #cancel(job, reason) {
    job.controller.abort(reason); job.reject(reason);
    if (this.#pending === job) {this.#pending = null; this.#finish(job);}
  }
  #remove(key) {const entry = this.#cache.get(key); this.#bytes -= entry.size; this.#cache.delete(key);}
  #prune() {
    for (const [key, entry] of this.#cache) if (entry.expiresAt <= this.#now()) this.#remove(key);
    while (this.#cache.size > previewLimits.maxEntries || this.#bytes > previewLimits.maxCacheBytes) this.#remove(this.#cache.keys().next().value);
  }
  async #run(job) {
    this.#active = job;
    const {selection, controller} = job, {signal} = controller;
    let abort;
    try {
      const waiting = new Promise((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once: true});
      });
      signal.throwIfAborted();
      const video = await Promise.race([job.loadVideo(signal), waiting]);
      signal.removeEventListener('abort', abort); signal.throwIfAborted();
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new AppError(422, 'preview_unavailable', 'error_post_missing_23');
      if (!Number.isFinite(selection.seconds) || selection.seconds < 0 || selection.seconds > video.duration) throw new AppError(400, 'preview_seconds', 'error_preview_seconds_22');
      const source = selectPreviewSource(video);
      if (!source) throw new AppError(422, 'preview_unavailable', 'error_post_missing_23');
      const key = JSON.stringify([selection.sessionKey, selection.blog, selection.postId, selection.videoId, selection.seconds]);
      this.#prune();
      const cached = this.#cache.get(key);
      if (cached) {this.#cache.delete(key); this.#cache.set(key, cached); job.resolve(cached.value); return;}
      const jpeg = await this.#decode({sourceUrl: source.url, userAgent: selection.userAgent, seconds: selection.seconds, signal, maxBytes: previewLimits.maxFrameBytes});
      signal.throwIfAborted();
      if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg.length > previewLimits.maxFrameBytes
        || jpeg.readUInt16BE(0) !== 0xffd8 || jpeg.readUInt16BE(jpeg.length-2) !== 0xffd9) throw new AppError(502, 'preview_unavailable', 'error_post_missing_23');
      const value = {image: `data:image/jpeg;base64,${jpeg.toString('base64')}`, seconds: selection.seconds};
      const entry = {sessionKey: selection.sessionKey, value, expiresAt: this.#now()+previewLimits.ttlMs};
      entry.size = Buffer.byteLength(JSON.stringify({key, ...entry}));
      this.#cache.set(key, entry); this.#bytes += entry.size; this.#prune(); job.resolve(value);
    } catch (error) {job.reject(signal.aborted ? signal.reason : error);}
    finally {
      if (abort) signal.removeEventListener('abort', abort); this.#finish(job); this.#active = null;
      const next = this.#pending; this.#pending = null;
      if (next && !this.#closed) void this.#run(next);
    }
  }
  clearSession(sessionKey) {
    for (const [key, entry] of this.#cache) if (entry.sessionKey === sessionKey) this.#remove(key);
    for (const job of [this.#active, this.#pending]) if (job?.selection.sessionKey === sessionKey) this.#cancel(job, cancelled());
  }
  async close() {
    this.#closed = true; this.#cache.clear(); this.#bytes = 0;
    if (this.#pending) this.#cancel(this.#pending, cancelled());
    if (this.#active) {const active = this.#active; this.#cancel(active, cancelled()); await active.done;}
  }
}
