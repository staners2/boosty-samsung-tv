import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewService, previewLimits} from '../server/preview.mjs';
import {AppError} from '../server/errors.mjs';

const jpeg = Buffer.from([255,216,255,217]);
const selection = {sessionKey: 'session-a', blog: 'reader', postId: 'post-1', videoId: 'content-17', seconds: 90, userAgent: 'test-TV'};
const video = {duration: 1000, sources: [{quality: 'tiny', url: 'https://vd580.okcdn.ru/a.mp4'}]};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('exact seconds are cached only after a fresh access check', async t => {
  let loads = 0, decodes = 0;
  const service = new PreviewService({decodeFrame: async () => {decodes++; return jpeg;}}); t.after(() => service.close());
  const load = async () => {loads++; return video;};
  const first = await service.get(selection, load); assert.match(first.image, /^data:image\/jpeg;base64,/); assert.equal(first.seconds, 90);
  await service.get(selection, load); assert.equal(loads, 2); assert.equal(decodes, 1);
  await service.get({...selection, seconds: 91}, load); assert.equal(decodes, 2);
  await service.get({...selection, sessionKey: 'session-b'}, load); assert.equal(decodes, 3);
  await assert.rejects(service.get(selection, async () => {throw new AppError(403, 'preview_forbidden', 'Кадр недоступен.');}), {code: 'preview_forbidden'});
  service.clearSession(selection.sessionKey); await service.get(selection, load); assert.equal(decodes, 4);
});

test('cache expires without extending TTL and evicts the least recently used entry', async t => {
  let now = 0, decodes = 0;
  const service = new PreviewService({now: () => now, decodeFrame: async () => {decodes++; return jpeg;}}); t.after(() => service.close());
  const get = seconds => service.get({...selection, seconds}, async () => video);
  await get(0); now = previewLimits.ttlMs-1; await get(0); assert.equal(decodes, 1);
  now++; await get(0); assert.equal(decodes, 2);
  for (let seconds = 1; seconds < 128; seconds++) await get(seconds);
  await get(0); assert.equal(decodes, 129);
  await get(128); await get(0); assert.equal(decodes, 130);
  await get(1); assert.equal(decodes, 131);
});

test('encoded cache byte limit evicts before the count limit and failures are not cached', async t => {
  let decodes = 0;
  const frame = Buffer.alloc(65536); frame.writeUInt16BE(0xffd8, 0); frame.writeUInt16BE(0xffd9, frame.length-2);
  const service = new PreviewService({decodeFrame: async () => {decodes++; if (decodes === 1) throw new Error('decoder test failure'); return frame;}}); t.after(() => service.close());
  const get = seconds => service.get({...selection, seconds}, async () => video);
  await assert.rejects(get(0));
  for (let seconds = 0; seconds < 60; seconds++) await get(seconds);
  await get(59); assert.equal(decodes, 61);
  await get(0); assert.equal(decodes, 62);
});

test('invalid duration, unsupported HLS and out-of-range seconds never invoke the decoder', async t => {
  const service = new PreviewService({decodeFrame: async () => {throw new Error('must not decode');}}); t.after(() => service.close());
  for (const duration of [0, NaN, Infinity]) await assert.rejects(service.get(selection, async () => ({...video, duration})), {code: 'preview_unavailable'});
  await assert.rejects(service.get({...selection, seconds: 1001}, async () => video), {code: 'preview_seconds'});
  await assert.rejects(service.get(selection, async () => ({...video, sources: [{quality: 'hls', url: 'https://vd580.okcdn.ru/a.m3u8'}]})), {code: 'preview_unavailable'});
});

test('accepted replacement waits for old decoder cleanup and never evicts a foreign pending owner', async t => {
  let active = 0, maximum = 0, finish;
  const decoded = [];
  const service = new PreviewService({decodeFrame: async ({seconds, signal}) => {
    active++; maximum = Math.max(maximum, active); decoded.push(seconds);
    if (seconds === 90) await new Promise(resolve => {finish = resolve;});
    active--; signal.throwIfAborted(); return jpeg;
  }}); t.after(() => service.close());
  const a = service.get(selection, async () => video); const checkedA = assert.rejects(a, {code: 'preview_cancelled'}); await tick();
  const b = service.get({...selection, sessionKey: 'session-b', seconds: 91}, async () => video);
  await assert.rejects(service.get({...selection, sessionKey: 'session-c', seconds: 92}, async () => video), {code: 'preview_busy'});
  await assert.rejects(service.get({...selection, seconds: 93}, async () => video), {code: 'preview_busy'});
  service.clearSession('session-a'); await checkedA; assert.equal(active, 1); assert.deepEqual(decoded, [90]);
  finish(); await b; assert.equal(maximum, 1); assert.deepEqual(decoded, [90,91]);
});

test('own newest selection cancels old work but its decoder starts only after cleanup', async t => {
  let finish, calls = 0;
  const service = new PreviewService({decodeFrame: async ({signal}) => {calls++; if (calls === 1) await new Promise(resolve => {finish = resolve;}); signal.throwIfAborted(); return jpeg;}}); t.after(() => service.close());
  const old = service.get(selection, async () => video); const checked = assert.rejects(old, {code: 'preview_cancelled'}); await tick();
  const current = service.get({...selection, seconds: 91}, async () => video); await checked; assert.equal(calls, 1);
  finish(); assert.equal((await current).seconds, 91); assert.equal(calls, 2);
  await service.get(selection, async () => video); assert.equal(calls, 3);
});

test('deadline includes queue time, preserves decoder cleanup, and close prevents later admission', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let finish, calls = 0;
  const service = new PreviewService({decodeFrame: async () => {calls++; return new Promise(resolve => {finish = () => resolve(jpeg);});}});
  const active = service.get(selection, async () => video); const activeCheck = assert.rejects(active, {code: 'preview_timeout'}); await tick();
  const queued = service.get({...selection, sessionKey: 'session-b'}, async () => video); const queuedCheck = assert.rejects(queued, {code: 'preview_timeout'});
  t.mock.timers.tick(9500); await activeCheck; await queuedCheck; assert.equal(calls, 1);
  let closed = false; const closing = service.close().then(() => {closed = true;}); await tick(); assert.equal(closed, false);
  finish(); await closing; assert.equal(closed, true);
  await assert.rejects(service.get(selection, async () => video), {code: 'preview_cancelled'});
});
