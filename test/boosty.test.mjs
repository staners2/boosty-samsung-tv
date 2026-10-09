import test from 'node:test';
import assert from 'node:assert/strict';
import { BoostyClient } from '../server/boosty.mjs';

test('media requests use the playback client agent so CDN signatures match', async () => {
  let agent;
  const client = new BoostyClient({fetch: async (_url, options) => {
    agent = options.headers.get('user-agent');
    return Response.json({data: []});
  }});
  await client.request({accessToken: 'test'}, 'v1/feed/post/', {userAgent: 'Safari test client'});
  assert.equal(agent, 'Safari test client');
  await assert.rejects(client.request({}, 'v1/feed/post/', {userAgent: 'x'.repeat(1025)}), {code: 'invalid_user_agent'});
});

test('phone login uses Boosty web fields and never sends an empty bearer header', async () => {
  const requests = [];
  const client = new BoostyClient({ fetch: async (url, options) => {
    requests.push({ url: String(url), options });
    return Response.json({ data: { phoneCode: { code: 'challenge-1', expiresIn: 180 } } });
  } });
  assert.deepEqual(await client.sendCode('device-1', '+79991234567'), { code: 'challenge-1', expiresIn: 180 });
  const call = requests[0];
  assert.equal(call.url, 'https://api.boosty.to/auth/phone/verification_code/send');
  assert.equal(call.options.headers.get('authorization'), null);
  assert.equal(call.options.headers.get('x-from-id'), 'device-1');
  assert.equal(call.options.headers.get('x-app'), 'web');
  assert.equal(call.options.body.toString(), 'phone=%2B79991234567&device_os=web&device_id=device-1');
});

test('verification rejects incomplete token responses rather than connecting an unusable session', async () => {
  const client = new BoostyClient({ fetch: async () => Response.json({ access_token: 'only-access' }) });
  await assert.rejects(client.verifyCode('device', '+79991234567', 'challenge', '123456'),
    { code: 'upstream_response' });
});

test('parallel expired requests refresh once and retain a refresh token omitted in the response', async () => {
  let refreshCount = 0;
  let updated = 0;
  const session = { accessToken: 'old-access', refreshToken: 'old-refresh', deviceId: 'device', expiresAt: 1 };
  const client = new BoostyClient({ now: () => 1000, onUpdate: async () => { updated++; }, fetch: async (url, options) => {
    if (String(url).endsWith('/oauth/token/')) {
      refreshCount++;
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.equal(options.body.get('refresh_token'), 'old-refresh');
      return Response.json({ access_token: 'new-access', expires_in: 3600 });
    }
    assert.equal(options.headers.get('authorization'), 'Bearer new-access');
    return Response.json({ id: 'user-1' });
  } });
  const results = await Promise.all([client.request(session, 'v1/user/current'), client.request(session, 'v1/user/current')]);
  assert.deepEqual(results, [{ id: 'user-1' }, { id: 'user-1' }]);
  assert.equal(refreshCount, 1);
  assert.equal(updated, 1);
  assert.equal(session.refreshToken, 'old-refresh');
  assert.equal(session.expiresAt, 3601000);
});

test('an unauthorized response retries once with refreshed credentials', async () => {
  const session = { accessToken: 'old', refreshToken: 'refresh', deviceId: 'device', expiresAt: null };
  let calls = 0;
  const client = new BoostyClient({ fetch: async (url, options) => {
    if (String(url).endsWith('/oauth/token/')) return Response.json({ access_token: 'new', refresh_token: 'new-refresh' });
    calls++;
    return options.headers.get('authorization') === 'Bearer old'
      ? Response.json({}, { status: 401 }) : Response.json({ id: 'restored' });
  } });
  assert.deepEqual(await client.request(session, 'v1/user/current'), { id: 'restored' });
  assert.equal(calls, 2);
  assert.equal(session.refreshToken, 'new-refresh');
});

test('upstream errors never expose raw response secrets or accept arbitrary proxy paths', async () => {
  const client = new BoostyClient({ fetch: async () => Response.json({ error: 'secret-token-number' }, { status: 403 }) });
  const session = { accessToken: 'test', expiresAt: null };
  await assert.rejects(client.request(session, 'v1/user/current'), error =>
    error.status === 403 && !error.message.includes('secret-token-number'));
  await assert.rejects(client.request(session, 'https://evil.example/collect'), /path/);
  await assert.rejects(client.request(session, '../collect'), /path/);
});
test('caller abort cancels content fetch and JSON reading without changing session identity', {timeout: 2000}, async () => {
  for (const json of [false, true]) {
    const controller = new AbortController();
    const session = {accessToken: 'test-access', refreshToken: 'test-refresh'};
    const wait = signal => new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    });
    const client = new BoostyClient({fetch: async (_url, options) => {
      if (!json) return wait(options.signal);
      return {ok: true, status: 200, json: () => {controller.abort(); return wait(options.signal);}};
    }});
    const pending = client.request(session, 'v1/blog/reader/post/post-1', {signal: controller.signal});
    if (!json) controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(session.accessToken, 'test-access');
  }
});

test('aborting one refresh waiter leaves the shared refresh available to another caller', {timeout: 2000}, async () => {
  let finishRefresh, contentCalls = 0;
  const controller = new AbortController(), session = {accessToken: 'old', refreshToken: 'refresh', expiresAt: 1};
  const client = new BoostyClient({fetch: async url => {
    if (url.endsWith('/oauth/token/')) return new Promise(resolve => {finishRefresh = () => resolve(Response.json({access_token: 'new', expires_in: 3600}));});
    contentCalls++; return Response.json({ok: true});
  }});
  const preview = client.request(session, 'v1/blog/reader/post/post-1', {signal: controller.signal});
  const feed = client.request(session, 'v1/feed/post/'); controller.abort();
  await assert.rejects(preview, {name: 'AbortError'}); assert.equal(contentCalls, 0);
  finishRefresh(); assert.deepEqual(await feed, {ok: true}); assert.equal(contentCalls, 1);
});
