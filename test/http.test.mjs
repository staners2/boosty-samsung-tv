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

async function start(t, basePath = '', {postResponse, preview, now, staticFiles = {}} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boosty-http-'));
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
      return path === 'v1/user/current' ? { id: 'profile', name: 'Профиль' }
        : postResponse && /^v1\/blog\/[^/]+\/post\/[^?]+\?/.test(path) ? postResponse
        : { data: [], extra: { isLast: true } };
    },
  };
  const server = await createApp({ publicUrl: 'http://localhost:3000', basePath,
    vault: new Vault(join(dir, 'sessions.enc'), randomBytes(32)), boosty,
    staticDir: join(dir, 'static'), preview, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {await Promise.all([new Promise(resolve => server.close(resolve)), server.closePreview?.()]);});
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': 'http://localhost:3000',
      'x-tv-request': '1', ...headers }, body: JSON.stringify(body) });
  return { base, post, requests };
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
