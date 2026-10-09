import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../web/tv/player.js';

function nativePlayer() {
  const calls = [];
  let listener;
  let prepare;
  let completeSeek;
  const avplay = {
    open: url => calls.push(['open', url]),
    close: () => calls.push(['close']),
    setDisplayRect() {}, setDisplayMethod() {},
    setStreamingProperty: (name, value) => calls.push(['property', name, value]),
    setListener: value => { listener = value; },
    prepareAsync: success => { prepare = success; },
    seekTo: (ms, success) => { calls.push(['seek', ms]); completeSeek = success; },
    play: () => calls.push(['play']), pause: () => calls.push(['pause']),
    getDuration: () => 100000,
  };
  return {avplay, calls, prepared: () => prepare(), sought: () => completeSeek(), position: ms => listener.oncurrentplaytime(ms), completed: () => listener.onstreamcompleted(),
    failed: () => listener.onerror(), buffered: () => {listener.onbufferingstart(); listener.onbufferingcomplete();}};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('native playback sets the same user agent before preparing the signed source', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay, userAgent: 'Tizen test client'});
  const opening = player.open({url: 'https://video.example/movie.mp4'});
  await tick();
  assert.deepEqual(native.calls.slice(0, 2), [
    ['open', 'https://video.example/movie.mp4'], ['property', 'USER_AGENT', 'Tizen test client'],
  ]);
  native.prepared(); await opening; await player.close();
});

test('closed player never restarts from a late prepare callback', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay});
  const opening = player.open({url: 'https://video.example/movie.mp4'}, 0);
  await tick();
  const closing = player.close();
  native.prepared();
  await Promise.all([opening, closing]);
  assert.equal(native.calls.some(([name]) => name === 'play'), false);
  assert.equal(player.state, 'closed');
});

test('resume and seek wait for native seek completion, clamp to video limits', async () => {
  const native = nativePlayer();
  const positions = [];
  const player = new Player({avplay: native.avplay, onProgress: seconds => positions.push(seconds)});
  const opening = player.open({url: 'https://video.example/movie.mp4'}, 30);
  await tick(); native.prepared(); await tick();
  assert.deepEqual(native.calls.filter(([name]) => name === 'seek'), [['seek', 30000]]);
  assert.equal(native.calls.some(([name]) => name === 'play'), false);
  native.sought(); await opening;
  native.position(35000);
  assert.deepEqual(positions, [35]);
  const seeking = player.seek(-99);
  await tick(); native.sought(); await seeking;
  assert.equal(player.position, 0);
  const end = player.seek(200);
  await tick(); native.sought(); await end;
  assert.equal(player.position, 99.5);
  await player.close();
});

test('quality switch retains paused position and closes the previous source', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay});
  const first = player.open({url: 'https://video.example/720.mp4'});
  await tick(); native.prepared(); await first;
  native.position(42000);
  await player.toggle();
  const second = player.open({url: 'https://video.example/1080.mp4'}, player.position, true);
  await tick(); native.prepared(); await tick(); native.sought(); await second;
  assert.equal(player.state, 'paused');
  assert.deepEqual(native.calls.filter(([name]) => name === 'seek'), [['seek', 42000]]);
  assert.equal(native.calls.filter(([name]) => name === 'close').length, 1);
  await player.close();
});

test('close during a pending seek waits before another native API call', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay});
  const opening = player.open({url: 'https://video.example/a.mp4'});
  await tick(); native.prepared(); await opening;
  const seeking = player.seek(10); await tick();
  const closing = player.close(); await tick();
  assert.equal(native.calls.some(([name]) => name === 'close'), false);
  native.sought(); await Promise.all([seeking, closing]);
  assert.equal(native.calls.at(-1)[0], 'close');
});

test('completed video can be rewound and restarted with OK', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay});
  const opening = player.open({url: 'https://video.example/a.mp4'});
  await tick(); native.prepared(); await opening;
  native.position(100000); native.completed();
  const rewind = player.seek(-10); await tick();
  assert.deepEqual(native.calls.at(-1), ['seek', 90000]);
  native.sought(); await rewind;
  assert.equal(player.state, 'playing');
  native.completed();
  const restart = player.toggle(); await tick();
  assert.deepEqual(native.calls.at(-1), ['seek', 0]);
  native.sought(); await restart;
  assert.equal(player.position, 0);
  assert.equal(player.state, 'playing');
  await player.close();
});

test('a native runtime error stays visible after late buffering callbacks', async () => {
  const native = nativePlayer(), states = [];
  const player = new Player({avplay: native.avplay, onState: state => states.push(state)});
  const opening = player.open({url: 'https://video.example/a.mp4'});
  await tick(); native.prepared(); await opening;
  native.failed(); native.buffered();
  assert.equal(player.state, 'error');
  assert.equal(states.at(-1), 'error');
  await player.toggle();
  assert.equal(native.calls.filter(([name]) => name === 'play').length, 1);
  await player.close();
});

test('HTML video supports pause, seek and close, and records a runtime failure', async () => {
  const video = new class extends EventTarget {
    duration = 100; currentTime = 0; paused = true; src = '';
    play() {this.paused = false; return Promise.resolve();}
    pause() {this.paused = true;}
    removeAttribute(name) {if (name === 'src') this.src = '';}
    load() {if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));}
  };
  const player = new Player({video});
  await player.open({url: 'https://video.example/a.mp4'});
  assert.equal(player.state, 'playing');
  await player.toggle(); assert.equal(video.paused, true);
  await player.seek(12); assert.equal(video.currentTime, 12);
  video.onerror(); assert.equal(player.state, 'error');
  await player.close(); assert.equal(video.src, '');
});

test('absolute seek uses the selected timestamp rather than adding it to playback', async () => {
  const native = nativePlayer();
  const player = new Player({avplay: native.avplay});
  const opening = player.open({url: 'https://video.example/movie.mp4'});
  await tick(); native.prepared(); await opening; native.position(30000);
  const seeking = player.seek(50, {absolute: true});
  await tick();
  assert.deepEqual(native.calls.at(-1), ['seek', 50000]);
  native.sought(); await seeking; assert.equal(player.position, 50);
  await player.close();
});
