import test from 'node:test';
import assert from 'node:assert/strict';
import {FramePreview} from '../web/tv/preview.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const jpeg = 'data:image/jpeg;base64,/9j/2Q==';
const target = {blog: 'author', postId: 'post', videoId: 'content', seconds: 20, caption: 'Глава'};

test('a cache miss immediately shows the nearest frame with its real time, then the exact frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target); t.mock.timers.tick(250); await tick();
  requests[0].resolve({seconds: 20, image: jpeg}); await tick();
  preview.select({...target, seconds: 35, caption: 'Другая глава'});
  assert.equal(states.at(-1).status, 'cached');
  assert.equal(states.at(-1).image, jpeg);
  assert.equal(states.at(-1).frameSeconds, 20);
  assert.equal(states.at(-1).target.seconds, 35);
  assert.equal(requests.length, 1);
  t.mock.timers.tick(250); await tick();
  requests[1].resolve({seconds: 35, image: 'data:image/jpeg;base64,/9j/AA/2Q=='}); await tick();
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.seconds, 35);
  assert.equal(states.at(-1).image, 'data:image/jpeg;base64,/9j/AA/2Q==');
  preview.clear();
});

test('selecting an in-flight prefetched frame promotes it without aborting or requesting it again', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target, [{...target, seconds: 30}, {...target, seconds: 10}]);
  t.mock.timers.tick(250); await tick(); requests[0].resolve({seconds: 20, image: jpeg}); await tick();
  t.mock.timers.tick(500); await tick();
  preview.select({...target, seconds: 30, caption: 'Выбранная глава'}, [{...target, seconds: 40}]);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(states.at(-1).frameSeconds, 20);
  requests[1].resolve({seconds: 30, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.caption, 'Выбранная глава');
  assert.deepEqual(requests.map(request => request.selected.seconds), [20, 30]);
  t.mock.timers.tick(500); await tick();
  assert.deepEqual(requests.map(request => request.selected.seconds), [20, 30, 40]);
  preview.clear(); requests[2].resolve({seconds: 40, image: jpeg}); await tick();
});

test('reselecting a still-loading exact frame retains the request and the newest caption', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target); t.mock.timers.tick(250); await tick();
  preview.select({...target, caption: 'Обновлённое описание'});
  assert.equal(requests[0].signal.aborted, false);
  requests[0].resolve({seconds: 20, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.caption, 'Обновлённое описание');
  t.mock.timers.tick(250); await tick();
  assert.equal(requests.length, 1);
  preview.clear();
});

test('the larger cache keeps visited frames through a minute of watching', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let now = 0;
  const states = [], requested = [];
  const preview = new FramePreview({now: () => now, onChange: state => states.push(state), request: async selected => {
    requested.push(selected.seconds); return {seconds: selected.seconds, image: jpeg};
  }});
  for (let seconds = 0; seconds < 12; seconds++) {
    preview.select({...target, seconds}); t.mock.timers.tick(250); await tick();
  }
  now = 60001; preview.select({...target, seconds: 0});
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.seconds, 0);
  assert.equal(requested.length, 12);
  preview.clear();
});

test('nearby-frame fallback never crosses video identity or survives lost access', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [];
  let denied = false;
  const preview = new FramePreview({onChange: state => states.push(state), request: async selected => {
    if (denied) throw Object.assign(new Error('Access denied'), {status: 403});
    return {seconds: selected.seconds, image: jpeg};
  }});
  preview.select(target); t.mock.timers.tick(250); await tick();
  preview.select({...target, videoId: 'another', seconds: 25});
  assert.equal(states.at(-1).status, 'loading');
  assert.equal(states.at(-1).image, null);
  preview.select({...target, seconds: 25});
  assert.equal(states.at(-1).status, 'cached');
  denied = true; t.mock.timers.tick(250); await tick();
  assert.equal(states.at(-1).status, 'error');
  assert.equal(states.at(-1).image, null);
  preview.select(target);
  assert.equal(states.at(-1).status, 'loading');
  preview.clear();
});

test('preview debounces selection, cancels old requests and ignores stale frames', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target); t.mock.timers.tick(200);
  preview.select({...target, seconds: 30}); t.mock.timers.tick(249);
  assert.equal(requests.length, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(requests.length, 1);
  requests[0].resolve({seconds: 30, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'ready');
  preview.select({...target, seconds: 40});
  assert.equal(states.at(-1).status, 'cached');
  assert.equal(states.at(-1).frameSeconds, 30);
  t.mock.timers.tick(250); await tick();
  preview.select({...target, seconds: 50});
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({seconds: 40, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'cached');
  assert.equal(states.at(-1).target.seconds, 50);
  assert.equal(states.at(-1).frameSeconds, 30);
  t.mock.timers.tick(250); await tick();
  preview.clear(); requests[2].resolve({seconds: 50, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'hidden');
});

test('preview rejects mismatched frames, unsafe or oversized images and missing content identity', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [];
  let value;
  const preview = new FramePreview({onChange: state => states.push(state), request: async () => value});
  for (const response of [{seconds: 21, image: jpeg}, {seconds: 20, image: 'https://example/image'}, {seconds: 20, image: `data:image/jpeg;base64,${'A'.repeat(88 * 1024)}`}]) {
    value = response; preview.select(target); t.mock.timers.tick(250); await tick();
    assert.equal(states.at(-1).status, 'error');
    assert.equal(states.at(-1).image, null);
  }
  preview.select({...target, videoId: null});
  assert.equal(states.at(-1).status, 'error');
  preview.clear();
});

test('idle prefetch prepares neighbors sequentially without changing the visible frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target, [{...target, seconds: 30}, {...target, seconds: 10}]);
  t.mock.timers.tick(250); await tick();
  requests[0].resolve({seconds: 20, image: jpeg}); await tick();
  t.mock.timers.tick(500); await tick();
  assert.deepEqual(requests.map(request => request.selected.seconds), [20, 30]);
  assert.equal(states.at(-1).target.seconds, 20);
  requests[1].resolve({seconds: 30, image: jpeg}); await tick();
  assert.deepEqual(requests.map(request => request.selected.seconds), [20, 30, 10]);
  assert.equal(states.at(-1).target.seconds, 20);
  requests[2].resolve({seconds: 10, image: jpeg}); await tick();
  preview.select({...target, seconds: 30, caption: 'Следующая глава'});
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.caption, 'Следующая глава');
  assert.equal(requests.length, 3);
  preview.clear();
});

test('a foreground selection aborts prefetch and ignores its late frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requests = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: (selected, signal) => new Promise(resolve => requests.push({selected, signal, resolve}))});
  preview.select(target, [{...target, seconds: 30}, {...target, seconds: 10}]);
  t.mock.timers.tick(250); await tick(); requests[0].resolve({seconds: 20, image: jpeg}); await tick();
  t.mock.timers.tick(500); await tick();
  assert.equal(requests.length, 2);
  preview.select({...target, seconds: 40});
  assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve({seconds: 30, image: jpeg}); await tick();
  assert.equal(states.at(-1).status, 'cached');
  assert.equal(states.at(-1).frameSeconds, 20);
  assert.equal(states.at(-1).target.seconds, 40);
  t.mock.timers.tick(250); await tick();
  assert.equal(requests[2].selected.seconds, 40);
  requests[2].resolve({seconds: 40, image: jpeg}); await tick();
  preview.select({...target, seconds: 30});
  assert.equal(states.at(-1).status, 'cached');
  assert.notEqual(states.at(-1).frameSeconds, 30);
  t.mock.timers.tick(250); await tick();
  assert.equal(requests[3].selected.seconds, 30);
  requests[3].resolve({seconds: 30, image: jpeg}); await tick();
  preview.clear();
});

test('prefetch skips duplicates, invalid times and unrelated content and bounds each batch', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const requested = [], states = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: async selected => {
    requested.push(selected.seconds); return {seconds: selected.seconds, image: jpeg};
  }});
  preview.select(target, [target, {...target, seconds: 30}, {...target, seconds: 30},
    {...target, seconds: -1}, {...target, seconds: NaN}, {...target, postId: 'other', seconds: 90},
    {...target, videoId: 'other', seconds: 90}, ...[10, 40, 50, 60].map(seconds => ({...target, seconds}))]);
  t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.deepEqual(requested, [20, 30, 10, 40, 50]);
  assert.equal(states.at(-1).target.seconds, 20);
  preview.clear();
});

test('preview cache separates video identities and clears on navigation', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requested = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: async selected => {
    requested.push([selected.postId, selected.videoId]); return {seconds: selected.seconds, image: jpeg};
  }});
  preview.select(target); t.mock.timers.tick(250); await tick();
  preview.select({...target, videoId: 'content-2'});
  assert.equal(states.at(-1).status, 'loading');
  t.mock.timers.tick(250); await tick();
  preview.select(target); assert.equal(states.at(-1).status, 'ready');
  preview.clear(); preview.select(target);
  assert.equal(states.at(-1).status, 'loading');
  t.mock.timers.tick(250); await tick();
  preview.select({...target, postId: 'other'}); t.mock.timers.tick(250); await tick();
  preview.select(target); assert.equal(states.at(-1).status, 'loading');
  assert.deepEqual(requested, [['post', 'content'], ['post', 'content-2'], ['post', 'content'], ['other', 'content']]);
  preview.clear();
});

test('cached frames expire without extending their lifetime on reuse', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let now = 0;
  const states = [];
  const preview = new FramePreview({now: () => now, onChange: state => states.push(state), request: async selected => ({seconds: selected.seconds, image: jpeg})});
  preview.select(target); t.mock.timers.tick(250); await tick();
  now = 299999; preview.select(target); assert.equal(states.at(-1).status, 'ready');
  now = 300001; preview.select(target); assert.equal(states.at(-1).status, 'loading');
  preview.clear();
});

test('frame cache evicts old frames by count and image memory rather than growing forever', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const image of [jpeg, 'data:image/jpeg;base64,'+'A'.repeat(80*1024)]) {
    const states = [];
    const preview = new FramePreview({onChange: state => states.push(state), request: async selected => ({seconds: selected.seconds, image})});
    const count = image === jpeg ? 33 : 27;
    for (let seconds = 0; seconds < count; seconds++) {
      preview.select({...target, seconds}); t.mock.timers.tick(250); await tick();
    }
    preview.select({...target, seconds: count-1}); assert.equal(states.at(-1).status, 'ready');
    preview.select({...target, seconds: 0}); assert.equal(states.at(-1).status, 'cached');
    assert.notEqual(states.at(-1).frameSeconds, 0);
    preview.clear();
  }
});

test('background network failures leave the selected frame usable', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [], requested = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: async selected => {
    requested.push(selected.seconds);
    if (selected.seconds !== 20) throw Object.assign(new Error('Offline'), {status: 502});
    return {seconds: selected.seconds, image: jpeg};
  }});
  preview.select(target, [{...target, seconds: 30}]);
  t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.deepEqual(requested, [20, 30]);
  assert.equal(states.at(-1).status, 'ready');
  assert.equal(states.at(-1).target.seconds, 20);
  preview.clear();
});

test('losing access during prefetch discards cached frames', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const states = [];
  const preview = new FramePreview({onChange: state => states.push(state), request: async selected => {
    if (selected.seconds !== 20) throw Object.assign(new Error('Access denied'), {status: 403});
    return {seconds: selected.seconds, image: jpeg};
  }});
  preview.select(target, [{...target, seconds: 30}]);
  t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.equal(states.at(-1).status, 'error');
  preview.select(target); assert.equal(states.at(-1).status, 'loading');
  preview.clear();
});
