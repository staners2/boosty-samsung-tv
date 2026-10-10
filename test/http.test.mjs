import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { Vault } from '../server/vault.mjs';
import { Api } from '../web/api.js';
import {PreviewService} from '../server/preview.mjs';
import {AppError} from '../server/errors.mjs';
import {BoostyClient} from '../server/boosty.mjs';

async function start(t, basePath = '', {postResponse, postClient, preview, now, vault, profileId = () => 'profile', onProgress, beforePost, progressError, postError, staticFiles = {}} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boosty-http-'));
  vault ??= new Vault(join(dir, 'sessions.enc'), randomBytes(32));
  for (const [path, content] of Object.entries(staticFiles)) {
    const file = join(dir, 'static', path);
    await mkdir(dirname(file), {recursive: true}); await writeFile(file, content);
  }
  const requests = [];
  const boosty = {
    sendCode: async () => ({ code: 'challenge', expiresIn: 180 }),
    verifyCode: async () => ({ accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: null }),
    request: async (_session, path, options) => {
      requests.push({path, options});
      if (path.startsWith('v1/viewstat/video/')) await onProgress?.(Number(options.body.get('time_code')));
      if (progressError && path.startsWith('v1/viewstat/video/')) throw progressError;
      if (/^v1\/blog\/[^/]+\/post\/[^?]+\?/.test(path)) await beforePost?.();
      if (postError && /^v1\/blog\/[^/]+\/post\/[^?]+\?/.test(path)) throw postError;
      if (postClient && /^v1\/blog\/[^/]+\/post\/[^?]+\?/.test(path)) return postClient.request(_session, path, options);
      return path === 'v1/user/current' ? { id: profileId(), name: 'Профиль' }
        : postResponse && /^v1\/blog\/[^/]+\/post\/[^?]+\?/.test(path) ? postResponse
        : postResponse && /^(v1\/feed\/post\/|v1\/blog\/[^/]+\/post\/)/.test(path) ? {data: [postResponse], extra: {isLast: true}}
        : { data: [], extra: { isLast: true } };
    },
  };
  const server = await createApp({ publicUrl: 'http://localhost:3000', basePath,
    vault, boosty,
    staticDir: join(dir, 'static'), preview, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const stop = async () => {await Promise.all([new Promise(resolve => server.close(resolve)), server.closePreview?.()]);};
  t.after(stop);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': 'http://localhost:3000',
      'x-tv-request': '1', ...headers }, body: JSON.stringify(body) });
  return { base, post, requests, vault, stop };
}

async function authorize({post}, prefix = '') {
  const pair = await (await post(prefix+'/api/pairs', {})).json();
  const headers = {'x-link-key': new URL(pair.linkUrl).hash.slice(1)};
  await post(`${prefix}/api/pairs/${pair.id}/send`, {phone: '+79991234567'}, headers);
  await post(`${prefix}/api/pairs/${pair.id}/verify`, {code: '123456'}, headers);
  const finish = await post(`${prefix}/api/pairs/${pair.id}/finish`, {}, {'x-poll-key': pair.pollKey});
  return {cookie: finish.headers.get('set-cookie').split(';')[0], 'x-tv-proof': (await finish.json()).tvProof};
}
const previewPost = {id: 'post-1', hasAccess: true, user: {blogUrl: 'reader'}, data: [
  {type: 'ok_video', id: 'content-17', vid: 'playback-42', duration: 180, playerUrls: [{type: 'tiny', url: 'https://vd580.okcdn.ru/a.mp4'}]},
]};

test('resume position survives a broker restart and expires exactly 24 hours after its last save', async t => {
  let now = 1700000000000;
  const postResponse = structuredClone(previewPost);
  const app = await start(t, '/reader', {postResponse, now: () => now});
  const headers = await authorize(app, '/reader');
  assert.equal((await app.post('/reader/api/progress', {videoId: 'playback-42', seconds: 72}, headers)).status, 200);
  await app.stop();
  const restarted = await start(t, '/reader', {postResponse, vault: app.vault, now: () => now});
  const progress = () => fetch(restarted.base + '/reader/api/progress/reader/post-1/playback-42', {headers});
  now += 24 * 60 * 60 * 1000 - 1;
  assert.deepEqual(await (await progress()).json(), {seconds: 72});
  const post = await (await fetch(restarted.base + '/reader/api/post/reader/post-1', {headers})).json();
  assert.equal(post.videos[0].timeCode, 72);
  now += 1;
  assert.deepEqual(await (await progress()).json(), {seconds: 0});
  assert.equal((await (await fetch(restarted.base + '/reader/api/post/reader/post-1', {headers})).json()).videos[0].timeCode, 0);
});

test('a fresh Boosty position, including an intentional rewind to zero, takes priority over the cache', async t => {
  const postResponse = structuredClone(previewPost);
  const app = await start(t, '', {postResponse}); const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 120}, headers);
  for (const seconds of [35, 0]) {
    postResponse.data[0].timeCode = seconds;
    const response = await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), {seconds});
    delete postResponse.data[0].timeCode;
    assert.equal((await (await fetch(app.base + '/api/post/reader/post-1', {headers})).json()).videos[0].timeCode, seconds);
  }
});

test('cached resume positions are shared only between sessions of the same Boosty account', async t => {
  let profile = 'account-a';
  const app = await start(t, '', {postResponse: structuredClone(previewPost), profileId: () => profile});
  const first = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 65}, first);
  const second = await authorize(app);
  const path = app.base + '/api/progress/reader/post-1/playback-42';
  assert.deepEqual(await (await fetch(path, {headers: second})).json(), {seconds: 65});
  profile = 'account-b'; const other = await authorize(app);
  assert.deepEqual(await (await fetch(path, {headers: other})).json(), {seconds: 0});
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, {headers: {...first, 'x-tv-proof': 'wrong'}})).status, 401);
  assert.equal((await fetch(path, {headers: {...first, origin: 'https://foreign.example'}})).status, 403);
});

test('progress remains durable when writing to Boosty fails without reporting a successful synchronization', async t => {
  const app = await start(t, '', {postResponse: structuredClone(previewPost), progressError: new AppError(502, 'upstream_unavailable', 'request_failed')});
  const headers = await authorize(app);
  const saved = await app.post('/api/progress', {videoId: 'playback-42', seconds: 80}, headers);
  assert.equal(saved.status, 502);
  await app.stop();
  const restarted = await start(t, '', {vault: app.vault, postResponse: structuredClone(previewPost)});
  assert.deepEqual(await (await fetch(restarted.base + '/api/progress/reader/post-1/playback-42', {headers})).json(), {seconds: 80});
});

test('transient Boosty failures fall back to a valid cached position but access denials do not', async t => {
  let now = 1700000000000;
  const app = await start(t, '', {postResponse: structuredClone(previewPost), now: () => now});
  const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 55}, headers);
  await app.stop();
  for (const [status, expected] of [[502, 200], [429, 200], [401, 401], [403, 403], [404, 404]]) {
    const restarted = await start(t, '', {vault: app.vault, postError: new AppError(status, 'upstream_error', 'request_failed'), now: () => now});
    const response = await fetch(restarted.base + '/api/progress/reader/post-1/playback-42', {headers});
    assert.equal(response.status, expected);
    if (expected === 200) assert.deepEqual(await response.json(), {seconds: 55});
    await restarted.stop();
  }
  now += 24 * 60 * 60 * 1000;
  const expired = await start(t, '', {vault: app.vault, postError: new AppError(502, 'upstream_error', 'request_failed'), now: () => now});
  assert.equal((await fetch(expired.base + '/api/progress/reader/post-1/playback-42', {headers})).status, 502);
});

test('progress lookup refuses a locked post or a video not belonging to the requested post', async t => {
  const postResponse = structuredClone(previewPost);
  const app = await start(t, '', {postResponse}); const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 80}, headers);
  assert.equal((await fetch(app.base + '/api/progress/reader/post-1/unknown', {headers})).status, 404);
  postResponse.hasAccess = false;
  assert.equal((await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers})).status, 403);
});

test('real Boosty client preserves non-transient failures instead of masking them with cached progress', async t => {
  let status = 404;
  const postClient = new BoostyClient({fetch: async () => new Response('{}', {status})});
  const app = await start(t, '', {postClient}); const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 55}, headers);
  for (const upstream of [404, 410, 422, 405, 403, 408, 429, 503]) {
    status = upstream;
    const response = await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
    const transient = upstream === 408 || upstream === 429 || upstream >= 500;
    assert.equal(response.status, transient ? 200 : upstream, `Boosty ${upstream}`);
    if (transient) assert.deepEqual(await response.json(), {seconds: 55});
  }
});

test('a fresh lookup cannot replace the local stop while its persistent save is pending', async t => {
  const postResponse = structuredClone(previewPost); postResponse.data[0].timeCode = 30;
  const app = await start(t, '', {postResponse}); const headers = await authorize(app);
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const save = app.vault.save.bind(app.vault);
  app.vault.save = async data => {
    const writing = save(data);
    if (Object.values(data.progress || {}).some(entry => entry.seconds === 37)) {entered(); await waiting;}
    await writing;
  };
  const saving = app.post('/api/progress', {videoId: 'playback-42', seconds: 37}, headers);
  await started;
  const response = await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
  const position = await response.json();
  release(); const saved = await saving;
  assert.deepEqual(position, {seconds: 30});
  assert.equal(saved.status, 200);
  assert.equal(Object.values((await app.vault.load()).progress)[0].seconds, 37);
});

test('a pre-save lookup cannot replace a completed stop in the same clock millisecond', async t => {
  const postResponse = structuredClone(previewPost); postResponse.data[0].timeCode = 30;
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const app = await start(t, '', {postResponse, now: () => 1700000000000, beforePost: async () => {entered(); await waiting;}});
  const headers = await authorize(app);
  const reading = fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
  await started;
  const saved = await app.post('/api/progress', {videoId: 'playback-42', seconds: 37}, headers);
  release(); const response = await reading;
  assert.equal(saved.status, 200);
  assert.deepEqual(await response.json(), {seconds: 30});
  assert.equal(Object.values((await app.vault.load()).progress)[0].seconds, 37);
});

test('feed and blog responses use a cached position only when Boosty omits one', async t => {
  const postResponse = structuredClone(previewPost);
  const app = await start(t, '', {postResponse}); const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 75}, headers);
  for (const path of ['/api/feed', '/api/blog/reader']) {
    const response = await fetch(app.base + path, {headers});
    assert.equal((await response.json()).items[0].videos[0].timeCode, 75);
  }
  postResponse.data[0].timeCode = 15;
  assert.equal((await (await fetch(app.base + '/api/feed', {headers})).json()).items[0].videos[0].timeCode, 15);
});

test('a final stop is cached immediately and upstream writes keep their arrival order', async t => {
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const applied = [];
  const app = await start(t, '', {postResponse: structuredClone(previewPost), onProgress: async seconds => {
    if (seconds === 30) {entered(); await waiting;}
    applied.push(seconds);
  }});
  const headers = await authorize(app);
  let persisted;
  const finalWritten = new Promise(resolve => {persisted = resolve;});
  const save = app.vault.save.bind(app.vault);
  app.vault.save = async data => {
    await save(data);
    if (Object.values(data.progress || {}).some(entry => entry.seconds === 37)) persisted();
  };
  const first = app.post('/api/progress', {videoId: 'playback-42', seconds: 30}, headers);
  await started;
  const final = app.post('/api/progress', {videoId: 'playback-42', seconds: 37}, headers);
  await finalWritten; await new Promise(resolve => setImmediate(resolve));
  const response = await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
  const position = await response.json();
  const premature = [...applied];
  release(); assert.equal((await first).status, 200); assert.equal((await final).status, 200);
  assert.deepEqual(position, {seconds: 37});
  assert.deepEqual(premature, []);
  assert.deepEqual(applied, [30, 37]);
});

test('a late failed Boosty lookup cannot serve a cached position after logout', async t => {
  let entered, release;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const app = await start(t, '', {postResponse: structuredClone(previewPost), beforePost: async () => {entered(); await waiting;},
    postError: new AppError(502, 'upstream_unavailable', 'request_failed')});
  const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 55}, headers);
  const progress = fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
  await started;
  assert.equal((await app.post('/api/logout', {}, headers)).status, 200);
  release(); assert.equal((await progress).status, 401);
});

test('a successful lookup cannot return progress after logout during its persistent save', async t => {
  const postResponse = structuredClone(previewPost); postResponse.data[0].timeCode = 30;
  const app = await start(t, '', {postResponse}); const headers = await authorize(app);
  let entered, release, blocked = false;
  const started = new Promise(resolve => {entered = resolve;});
  const waiting = new Promise(resolve => {release = resolve;});
  const save = app.vault.save.bind(app.vault);
  app.vault.save = async data => {
    const writing = save(data);
    if (!blocked) {blocked = true; entered(); await waiting;}
    await writing;
  };
  const reading = fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers});
  await started;
  const loggedOut = await app.post('/api/logout', {}, headers);
  release(); const response = await reading;
  assert.equal(loggedOut.status, 200);
  assert.equal(response.status, 401);
});

test('saving a new position restarts the 24-hour expiry without extending it on fallback reads', async t => {
  let now = 1700000000000;
  const app = await start(t, '', {postResponse: structuredClone(previewPost), now: () => now});
  const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 30}, headers);
  now += 23 * 60 * 60 * 1000;
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 60}, headers);
  now += 23 * 60 * 60 * 1000;
  const path = app.base + '/api/progress/reader/post-1/playback-42';
  assert.deepEqual(await (await fetch(path, {headers})).json(), {seconds: 60});
  now += 60 * 60 * 1000;
  assert.deepEqual(await (await fetch(path, {headers})).json(), {seconds: 0});
});

test('cached positions clamp to a known video duration and invalid updates never enter the cache', async t => {
  const app = await start(t, '', {postResponse: structuredClone(previewPost)}); const headers = await authorize(app);
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 200}, headers);
  for (const seconds of [-1, 0.5, 604801, '20']) assert.equal((await app.post('/api/progress', {videoId: 'playback-42', seconds}, headers)).status, 400);
  assert.deepEqual(await (await fetch(app.base + '/api/progress/reader/post-1/playback-42', {headers})).json(), {seconds: 180});
});

test('the persistent cache evicts expired entries and remains bounded across a large feed', async t => {
  let now = 1700000000000;
  const postResponse = {...structuredClone(previewPost), data: Array.from({length: 1002}, (_, index) => ({...previewPost.data[0], vid: `video-${index}`, timeCode: 20}))};
  const app = await start(t, '', {postResponse, now: () => now}); const headers = await authorize(app);
  assert.equal((await fetch(app.base + '/api/feed', {headers})).status, 200);
  assert.equal(Object.keys((await app.vault.load()).progress).length, 1000);
  now += 24 * 60 * 60 * 1000;
  await app.post('/api/progress', {videoId: 'playback-42', seconds: 65}, headers);
  const entries = Object.values((await app.vault.load()).progress);
  assert.deepEqual(entries, [{seconds: 65, savedAt: now}]);
});

test('hosted HTML and configuration use runtime origin and prefix, including HEAD', async t => {
  for (const prefix of ['', '/reader']) {
    const app = await start(t, prefix, {staticFiles: {
      'tv/index.html': '<script src="{{BASE_PATH}}/tv/config.js"></script>',
      'link/index.html': '<script src="{{BASE_PATH}}/link/app.js"></script>',
      'tv/config.js': 'BUILD_ORIGIN_MUST_NOT_LEAK',
    }});
    for (const surface of ['tv', 'link']) {
      const url = app.base + prefix + '/' + surface + '/config.js';
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), `globalThis.BOOSTY_TV_API = ${JSON.stringify('http://localhost:3000' + prefix)};\n`);
      const head = await fetch(url, {method: 'HEAD'});
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
    }
    const html = await (await fetch(app.base + prefix + '/tv/')).text();
    assert.equal(html, `<script src="${prefix}/tv/config.js"></script>`);
    if (prefix) assert.equal((await fetch(app.base + '/tv/config.js')).status, 404);
  }
});

test('preview requires cookie and proof, uses content ID and accepts no arbitrary URLs', async t => {
  const preview = new PreviewService({decodeFrame: async () => Buffer.from([255,216,255,217])});
  let now = Date.now();
  const app = await start(t, '/boosty-tv', {postResponse: previewPost, preview, now: () => now});
  const authenticated = await authorize(app, '/boosty-tv');
  const path = app.base+'/boosty-tv/api/preview/reader/post-1/content-17?seconds=';
  for (const seconds of ['', '-1', 'NaN', 'Infinity', '181', '0&seconds=1', '90&url=https://evil.example']) {
    assert.equal((await fetch(path+seconds, {headers: authenticated})).status, 400, seconds);
  }
  assert.equal((await fetch(path+'90')).status, 401);
  assert.equal((await fetch(path+'90', {headers: {...authenticated, 'x-tv-proof': 'wrong'}})).status, 401);
  assert.equal((await fetch(path+'90', {headers: {...authenticated, origin: 'https://evil.example'}})).status, 403);
  const response = await fetch(path+'90', {headers: {...authenticated, 'user-agent': 'test-TV'}});
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {image: 'data:image/jpeg;base64,/9j/2Q==', seconds: 90});
  assert.equal(app.requests.at(-1).options.userAgent, 'test-TV'); assert.ok(app.requests.at(-1).options.signal);
  assert.equal(app.requests.some(({options}) => options?.method === 'PUT'), false);
  for (const id of ['unknown', 'playback-42']) assert.equal((await fetch(path.replace('content-17',id)+'90', {headers: authenticated})).status, 404);
  now += 181*86400000;
  assert.equal((await fetch(path+'90', {headers: authenticated})).status, 401);
});

test('preview respects locked content, unavailable duration and HLS-only videos', async t => {
  for (const [postResponse, expected] of [[{...previewPost, hasAccess: false},403],
    [{...previewPost, data: [{...previewPost.data[0], duration: 0}]},422],
    [{...previewPost, data: [{...previewPost.data[0], playerUrls: [{type: 'hls', url: 'https://vd580.okcdn.ru/a.m3u8'}]}]},422]]) {
    const preview = new PreviewService({decodeFrame: async () => {throw new Error('must not decode');}});
    const app = await start(t, '', {postResponse, preview}); const authenticated = await authorize(app);
    assert.equal((await fetch(app.base+'/api/preview/reader/post-1/content-17?seconds=90', {headers: authenticated})).status, expected);
  }
});

test('preview disconnect and logout cancel work without serving a stale frame', {timeout: 2000}, async t => {
  for (const logout of [false, true]) {
    let ready, aborted = false;
    const entered = new Promise(resolve => {ready = resolve;});
    const preview = new PreviewService({decodeFrame: async ({signal}) => {
      ready(); await new Promise(resolve => signal.addEventListener('abort', () => {aborted = true; resolve();}, {once: true}));
      return Buffer.from([255,216,255,217]);
    }});
    const app = await start(t, '', {postResponse: previewPost, preview}); const authenticated = await authorize(app);
    const controller = new AbortController();
    const pending = fetch(app.base+'/api/preview/reader/post-1/content-17?seconds=90', {headers: authenticated, signal: controller.signal});
    const outcome = pending.then(async response => ({status: response.status, value: await response.json()}), () => ({disconnected: true}));
    await entered;
    if (logout) {assert.equal((await app.post('/api/logout', {}, authenticated)).status, 200);} else controller.abort();
    const result = await outcome; await new Promise(resolve => setTimeout(resolve,10));
    assert.equal(aborted, true); assert.equal(result.value?.image, undefined);
  }
});

test('rejects unauthorized content access and foreign origins', async t => {
  const { base, post } = await start(t);
  assert.equal((await fetch(base + '/api/feed')).status, 401);
  assert.equal((await post('/api/pairs', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/pairs', {}, { 'x-tv-request': '' })).status, 403);
  const response = await fetch(base + '/api/me', { headers: { origin: 'https://evil.example' } });
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('packaged Samsung client can create a QR without Origin but still needs its request header', async t => {
  const {base} = await start(t);
  const pair = await new Api(base).post('/api/pairs', {name: 'Samsung Boosty TV'});
  assert.match(pair.qrImage, /^data:image\/png;base64,/);
  const unmarked = await fetch(base + '/api/pairs', {method: 'POST',
    headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(unmarked.status, 403);
  assert.equal(unmarked.headers.get('access-control-allow-origin'), null);
});

test('QR phone verification, TV confirmation and HttpOnly cookie grant actual API access', async t => {
  const { base, post, requests } = await start(t);
  const create = await post('/api/pairs', { name: 'Гостиная' });
  assert.equal(create.status, 201);
  const pair = await create.json();
  assert.match(pair.linkUrl, /^http:\/\/localhost:3000\/link\/[^#]+#[\w-]+$/);
  assert.match(pair.qrImage, /^data:image\/png;base64,/);
  const linkKey = new URL(pair.linkUrl).hash.slice(1);
  const headers = { 'x-link-key': linkKey };
  assert.equal((await post(`/api/pairs/${pair.id}/send`, { phone: '+79991234567' }, headers)).status, 200);
  assert.equal((await post(`/api/pairs/${pair.id}/verify`, { code: '123456' }, headers)).status, 200);
  const poll = await fetch(base + `/api/pairs/${pair.id}`, { headers: { 'x-poll-key': pair.pollKey } });
  const state = await poll.json();
  assert.equal(state.state, 'confirm');
  assert.equal(JSON.stringify(state).includes('test-access'), false);
  const finish = await post(`/api/pairs/${pair.id}/finish`, {}, { 'x-poll-key': pair.pollKey });
  assert.equal(finish.status, 200);
  const finished = await finish.json();
  assert.equal(JSON.stringify(finished).includes('test-access'), false);
  const cookie = finish.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.equal((await fetch(base + '/api/me', {headers: {cookie: cookie.split(';')[0], origin: 'null'}})).status, 401);
  const me = await fetch(base + '/api/me', { headers: { cookie: cookie.split(';')[0], 'x-tv-proof': finished.tvProof } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { id: 'profile', name: 'Профиль', avatar: null });
  const authenticated = {cookie: cookie.split(';')[0], 'x-tv-proof': finished.tvProof};
  for (const path of ['/api/feed', '/api/blog/reader', '/api/post/reader/post-1']) {
    await fetch(base + path, {headers: {...authenticated, 'user-agent': 'Safari test client'}});
    assert.equal(requests.at(-1).options?.userAgent, 'Safari test client');
  }
  const qr = await post('/api/qr', {url: 'https://example.com/reading'}, authenticated);
  assert.equal(qr.status, 200);
  assert.match((await qr.json()).qrImage, /^data:image\/png;base64,/);
  assert.equal((await post('/api/qr', {url: 'javascript:alert(1)'}, authenticated)).status, 400);
  assert.equal((await post(`/api/pairs/${pair.id}/finish`, {}, { 'x-poll-key': pair.pollKey })).status, 404);
  assert.equal((await post('/api/logout', {}, {cookie: cookie.split(';')[0], origin: 'null', 'x-tv-proof': 'wrong'})).status, 401);
  const logout = await post('/api/logout', {}, { cookie: cookie.split(';')[0], 'x-tv-proof': finished.tvProof });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie: cookie.split(';')[0] } })).status, 401);
});

test('health stays public and TV preflight allows only its packaged null origin', async t => {
  const { base } = await start(t);
  assert.equal((await fetch(base + '/health')).status, 200);
  const cors = await fetch(base + '/api/feed', { method: 'OPTIONS', headers: {
    origin: 'null', 'access-control-request-method': 'GET',
  } });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), 'null');
  assert.equal(cors.headers.get('access-control-allow-credentials'), 'true');
});

test('broker mounted below an existing HTTPS host keeps QR, redirects and cookies within its prefix', async t => {
  const {base, post} = await start(t, '/boosty-tv');
  assert.equal((await fetch(base + '/api/me')).status, 404);
  assert.equal((await fetch(base + '/boosty-tv/health')).status, 200);
  assert.equal((await fetch(base + '/boosty-tv/', {redirect: 'manual'})).headers.get('location'), '/boosty-tv/tv/');
  const created = await post('/boosty-tv/api/pairs', {});
  assert.equal(created.status, 201);
  const pair = await created.json();
  assert.match(pair.linkUrl, /^http:\/\/localhost:3000\/boosty-tv\/link\//);
  const phoneHeaders = {'x-link-key': new URL(pair.linkUrl).hash.slice(1)};
  await post(`/boosty-tv/api/pairs/${pair.id}/send`, {phone: '+79991234567'}, phoneHeaders);
  await post(`/boosty-tv/api/pairs/${pair.id}/verify`, {code: '123456'}, phoneHeaders);
  const finish = await post(`/boosty-tv/api/pairs/${pair.id}/finish`, {}, {'x-poll-key': pair.pollKey});
  assert.match(finish.headers.get('set-cookie'), /Path=\/boosty-tv\//);
});
