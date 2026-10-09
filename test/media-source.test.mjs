import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {openMediaSource, validateMediaUrl, isPublicIPv4} from '../server/media-source.mjs';

const sourceUrl = 'https://vd580.okcdn.ru/movie.mp4';
function upstream(responses) {
  const calls = [];
  return {calls, resolve4: async () => ['8.8.8.8'], request(url, options, callback) {
    calls.push({url, options});
    const request = new EventEmitter();
    request.destroy = () => {request.destroyed = true; request.response?.destroy();};
    request.end = () => queueMicrotask(() => {
      if (request.destroyed) return;
      const result = responses.shift();
      const response = Readable.from(result.chunks ?? [Buffer.from(result.body ?? '0123')]);
      response.statusCode = result.status ?? 206;
      response.headers = result.headers ?? {'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 10-13/100'};
      request.response = response; callback(response);
    });
    return request;
  }};
}

test('source rejects private addresses and CDN lookalikes', () => {
  for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '::1', 'invalid']) {
    assert.equal(isPublicIPv4(ip), false, ip);
  }
  assert.equal(isPublicIPv4('8.8.8.8'), true);
  for (const url of ['http://vd580.okcdn.ru/a', 'file:///data/sessions.enc', 'https://okcdn.ru.evil.example/a',
    'https://evilokcdn.ru/a', 'https://okcdn.ru/a', 'https://user:password@vd580.okcdn.ru/a',
    'https://vd580.okcdn.ru:8443/a', 'https://vd580.okcdn.ru/a#frame']) assert.throws(() => validateMediaUrl(url), {code: 'preview_source'});
  assert.equal(validateMediaUrl(sourceUrl).hostname, 'vd580.okcdn.ru');
});

test('Range streaming pins validated DNS and forwards only the matching client agent', async t => {
  const dependencies = upstream([{}]);
  const source = await openMediaSource({url: sourceUrl, userAgent: 'Preview test'}, dependencies); t.after(source.close);
  const response = await fetch(source.url, {headers: {range: 'bytes=10-13', authorization: 'Bearer forbidden', cookie: 'forbidden'}});
  assert.equal(response.status, 206); assert.equal(await response.text(), '0123');
  const {url, options} = dependencies.calls[0];
  assert.equal(url.hostname, 'vd580.okcdn.ru'); assert.equal(options.servername, url.hostname);
  assert.equal(options.agent, false);
  assert.deepEqual(options.headers, {'user-agent': 'Preview test', accept: 'video/mp4', 'accept-encoding': 'identity', range: 'bytes=10-13'});
  options.lookup(url.hostname, {}, (error, address, family) => {assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);});
  assert.equal((await fetch(source.url+'/wrong')).status, 404);
  assert.equal((await fetch(source.url, {method: 'POST'})).status, 405);
  for (const range of ['bytes=1-0', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=9007199254740992-', 'bytes=x-y']) {
    assert.equal((await fetch(source.url, {headers: {range}})).status, 416);
  }
  await source.close(); await source.close();
  await assert.rejects(fetch(source.url));
});

test('source rejects unsafe redirects and invalid partial responses without following them', async t => {
  for (const result of [
    {status: 302, headers: {location: 'http://127.0.0.1/private'}},
    {status: 302, headers: {location: 'https://evil.example/private'}},
    {status: 200, headers: {'content-length': '4'}},
    {headers: {'content-range': 'bytes 11-14/100', 'content-length': '4'}},
    {headers: {'content-range': 'bytes 10-13/100', 'content-length': '5'}},
  ]) {
    const dependencies = upstream([result]);
    const source = await openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies); t.after(source.close);
    assert.equal((await fetch(source.url, {headers: {range: 'bytes=10-13'}})).status, 502);
    assert.equal(dependencies.calls.length, 1);
  }
});

test('redirects are revalidated and bounded to five hops', async t => {
  const dependencies = upstream(Array.from({length: 6}, () => ({status: 302, headers: {location: sourceUrl}})));
  let resolutions = 0; dependencies.resolve4 = async () => {resolutions++; return ['8.8.8.8'];};
  const source = await openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies); t.after(source.close);
  assert.equal((await fetch(source.url, {headers: {range: 'bytes=10-13'}})).status, 502);
  assert.equal(dependencies.calls.length, 6); assert.equal(resolutions, 6);
});

test('all DNS answers must be public and aborted DNS cannot open a connection later', async () => {
  const dependencies = upstream([]); dependencies.resolve4 = async () => ['8.8.8.8', '127.0.0.1'];
  await assert.rejects(openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies), {code: 'preview_source'});
  const controller = new AbortController(); let finish;
  dependencies.resolve4 = () => new Promise(resolve => {finish = resolve;});
  const waiting = openMediaSource({url: sourceUrl, userAgent: 'Test', signal: controller.signal}, dependencies);
  controller.abort(); await assert.rejects(waiting, {name: 'AbortError'});
  finish(['8.8.8.8']); await new Promise(resolve => setImmediate(resolve));
  assert.equal(dependencies.calls.length, 0);
});

test('suffix, HEAD and 416 responses retain valid range metadata', async t => {
  const dependencies = upstream([
    {headers: {'content-range': 'bytes 96-99/100', 'content-length': '4'}},
    {status: 200, headers: {'content-length': '100'}},
    {status: 416, headers: {'content-range': 'bytes */100'}, body: ''},
  ]);
  const source = await openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies); t.after(source.close);
  assert.equal((await fetch(source.url, {headers: {range: 'bytes=-4'}})).status, 206);
  const head = await fetch(source.url, {method: 'HEAD'}); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await fetch(source.url, {headers: {range: 'bytes=100-'}})).status, 416);
});

test('stream byte limit is cumulative across range requests', async t => {
  const chunk = Buffer.alloc(9*1024*1024);
  const dependencies = upstream(Array.from({length: 2}, () => ({status: 200, headers: {'content-length': String(chunk.length)}, chunks: [chunk]})));
  const source = await openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies); t.after(source.close);
  assert.equal((await (await fetch(source.url)).arrayBuffer()).byteLength, chunk.length);
  await assert.rejects(async () => (await fetch(source.url)).arrayBuffer());
  await source.close(); await assert.rejects(fetch(source.url));
});

test('disconnecting one range does not destroy another range of the same source', async t => {
  let finishFirst, finishSecond;
  async function* body(which) {
    yield Buffer.from('0123');
    await new Promise(resolve => {if (which === 1) finishFirst = resolve; else finishSecond = resolve;});
    yield Buffer.from('4567');
  }
  const headers = {'content-range': 'bytes 10-17/100', 'content-length': '8'};
  const dependencies = upstream([{chunks: body(1), headers}, {chunks: body(2), headers}]);
  const source = await openMediaSource({url: sourceUrl, userAgent: 'Test'}, dependencies); t.after(source.close);
  const controller = new AbortController();
  const first = await fetch(source.url, {headers: {range: 'bytes=10-17'}, signal: controller.signal});
  const second = await fetch(source.url, {headers: {range: 'bytes=10-17'}});
  controller.abort(); await assert.rejects(first.text());
  await new Promise(resolve => setTimeout(resolve, 10));
  const result = second.text().then(value => ({value}), () => ({error: true}));
  finishFirst(); await new Promise(resolve => setTimeout(resolve, 10)); finishSecond();
  assert.equal((await result).value, '01234567');
});
