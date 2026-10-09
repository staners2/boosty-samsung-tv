import test from 'node:test';
import assert from 'node:assert/strict';
import { Api } from '../web/api.js';

test('browser client uses cookies and explicit application headers, never browser token storage', async () => {
  const requests = [];
  const api = new Api('https://tv.example', async (url, options) => {
    requests.push({url, options});
    return new Response(JSON.stringify({ok: true}), {status: 200});
  });
  api.proof = 'device-session-proof';
  await api.get('/api/me');
  await api.post('/api/pairs/id/send', {phone: '+79991234567'}, {'X-Link-Key': 'one-time-key'});
  assert.equal(requests[0].url, 'https://tv.example/api/me');
  assert.equal(requests[0].options.credentials, 'include');
  assert.equal(requests[0].options.headers['X-TV-Proof'], 'device-session-proof');
  assert.equal(requests[1].options.headers['X-TV-Request'], '1');
  assert.equal(requests[1].options.headers['X-Link-Key'], 'one-time-key');
  assert.equal(requests[1].options.body, '{"phone":"+79991234567"}');
});

test('browser reports actionable API failures and a separate network failure', async () => {
  const denied = new Api('', async () => new Response('{"code":"reconnect","message":"Подключите телевизор"}', {status: 401}));
  await assert.rejects(denied.get('/api/me'), {status: 401, code: 'reconnect', messageKey: 'request_failed'});
  const offline = new Api('', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(offline.get('/api/me'), /Cannot reach/);
});

test('caller cancellation reaches fetch and body parsing without becoming a network error', async () => {
  const controller = new AbortController();
  let signal, finish;
  const api = new Api('', async (_, options) => {
    signal = options.signal;
    return {ok: true, json: () => new Promise(resolve => {finish = resolve;})};
  });
  const pending = api.get('/api/preview/a/p/v?seconds=1', {}, {signal: controller.signal});
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(); finish({seconds: 1});
  await assert.rejects(pending, {name: 'AbortError'});
  assert.equal(signal.aborted, true);
});

test('browser request retains its 25 second deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const api = new Api('', async (_, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true})));
  const pending = assert.rejects(api.get('/api/me'), /Cannot reach/);
  t.mock.timers.tick(25000);
  await pending;
});
