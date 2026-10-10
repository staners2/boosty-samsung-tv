import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const bundle = await build({entryPoints: ['web/tv/app.js'], bundle: true, format: 'iife', write: false, target: 'es2019'});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function screen({stallProgress = false, reading = false, browser = false, timecode = false, seekError = false, pages, feedOnly = false, stallFeed = false, stallInitialFeed = false, body, previewError = false, contentId = 'content-17', metadataDuration = 180, playbackDuration = 180, twoVideos = false, stallPreview = false, language = 'ru', storageBlocked = false, offline = false, cachedPosition = 0, resumePosition = 0, stallResume = false, resumeError = 0, progressError = false} = {}) {
  const {document, window} = parseHTML(await readFile('web/tv/index.html', 'utf8'));
  const calls = [];
  let listener, finishFeed, finishInitialFeed, focused, intersection, initialFeedCount = 0;
  const requests = [], previewRequests = [], resumeRequests = [], progressRequests = [];
  Object.defineProperty(document, 'activeElement', {get: () => focused?.isConnected && !focused.disabled ? focused : document.body, configurable: true});
  window.HTMLElement.prototype.focus = function () {
    if (this.disabled || this.closest('[inert]')) return;
    focused = this;
    this.dispatchEvent(new window.Event('focusin', {bubbles: true}));
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({left: 0, top: 0, width: 100, height: 40});
  window.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [this.getBoundingClientRect()]; };
  window.scrollX = 0; window.scrollY = 0;
  window.scrollTo = (x, y) => {window.scrollX = x; window.scrollY = y;};
  const video = {id: 'vid-1', contentId, title: 'Проверка просмотра', duration: metadataDuration, timeCode: cachedPosition, preview: null, sources: [
    {url: 'https://video.example/master.m3u8', quality: 'hls', label: 'Авто'},
    {url: 'https://video.example/a.mp4', quality: 'full_hd', label: '1080p'}]};
  const post = {id: 'post-1', blog: 'test-author', title: 'Проверка публикации', locked: false,
    preview: null, body: body ?? (timecode ? [{type: 'timecode', title: '1:30', seconds: 90, videoId: 'vid-1', description: 'Обсуждение результатов'}] : reading ? [{type: 'text', text: 'Текст поста <script>danger()</script>'},
      {type: 'image', url: 'https://images.example/photo.jpg', title: 'Иллюстрация'}] : []),
    videos: reading ? [] : twoVideos ? [video, {...video, id: 'vid-10', contentId: 'content-170', title: 'Другой ролик'}] : [video]};
  const htmlVideo = document.getElementById('browser-video');
  htmlVideo.pause = () => {}; htmlVideo.play = () => Promise.resolve();
  htmlVideo.canPlayType = () => '';
  Object.defineProperty(htmlVideo, 'duration', {get: () => playbackDuration});
  Object.defineProperty(htmlVideo, 'src', {get: () => htmlVideo.getAttribute('src'), set: value => htmlVideo.setAttribute('src', value)});
  htmlVideo.load = () => {if (htmlVideo.src) queueMicrotask(() => htmlVideo.dispatchEvent(new window.Event('loadedmetadata')));};
  const dialog = document.getElementById('choices');
  Object.defineProperty(dialog, 'open', {get: () => dialog.hasAttribute('open')});
  dialog.close = () => dialog.removeAttribute('open');
  dialog.showModal = () => dialog.setAttribute('open', '');
  const avplay = {
    open: () => calls.push(['open']), close: () => calls.push(['close']),
    play: () => calls.push(['play']), pause: () => calls.push(['pause']),
    setDisplayRect() {}, setDisplayMethod() {}, setStreamingProperty() {},
    setListener: value => {listener = value;}, prepareAsync: success => success(),
    seekTo: (ms, success, failure) => {calls.push(['seek', ms]); if (seekError) failure('NotSupportedError'); else success();}, getDuration: () => playbackDuration * 1000,
  };
  const fetch = async (path, options) => {
    requests.push(path);
    if (offline) throw new TypeError('offline');
    let body;
    if (path === '/api/me') body = {id: 'profile', name: 'Тестовый профиль'};
    else if (path === '/api/subscriptions') body = {items: [{id: 'author-1', blog: 'test-author', title: 'Тестовый автор', name: 'Автор'}], nextOffset: null};
    else if (path.startsWith('/api/feed') || path.startsWith('/api/blog/test-author')) {
      const offset = new URL(path, 'https://test.example').searchParams.get('offset') || '';
      body = pages ? pages[offset] : {items: [post], nextOffset: null};
      if (!offset && ++initialFeedCount === 1 && stallInitialFeed) return new Promise(resolve => {finishInitialFeed = () => resolve(Response.json(body));});
      if (body instanceof Error) return Response.json({message: body.message}, {status: 503});
      if (offset && stallFeed) return new Promise(resolve => {finishFeed = () => resolve(Response.json(body));});
    }
    else if (path.startsWith('/api/post/test-author/')) body = {...post, id: path.split('/').at(-1)};
    else if (path.startsWith('/api/preview/')) {
      if (previewError) return Response.json({message: 'Кадр недоступен.'}, {status: 502});
      const seconds = Number(new URL(path, 'https://test.example').searchParams.get('seconds'));
      const identity = path.includes('/content-170?') ? 2 : 1;
      body = {seconds, image: 'data:image/jpeg;base64,' + Buffer.from([255, 216, identity, seconds, 255, 217]).toString('base64')};
      if (stallPreview) return new Promise(resolve => previewRequests.push({path, signal: options.signal, finish: () => resolve(Response.json(body))}));
    }
    else if (path.startsWith('/api/progress/')) {
      const seconds = resumePosition;
      const response = value => resumeError ? Response.json({messageKey: 'request_failed'}, {status: resumeError}) : Response.json({seconds: value});
      if (stallResume) return new Promise(resolve => resumeRequests.push({path, signal: options.signal, finish: (value = seconds) => resolve(response(value))}));
      return response(seconds);
    }
    else if (path === '/api/progress') {
      const position = JSON.parse(options.body);
      const response = () => progressError ? Response.json({messageKey: 'request_failed'}, {status: 503}) : Response.json({ok: true});
      if (!progressError) resumePosition = position.seconds;
      if (stallProgress) return new Promise(resolve => progressRequests.push({body: position, finish: () => resolve(response())}));
      progressRequests.push({body: position});
      return response();
    } else throw new Error(`Unexpected test request ${path}`);
    return new Response(JSON.stringify(body));
  };
  const localStorage = {getItem: key => {if (storageBlocked) throw Error('blocked'); return key === 'boosty-tv-language' ? language : 'test-proof';}, setItem() {}, removeItem() {}};
  class IntersectionObserver {
    constructor(callback) {intersection = callback;}
    observe() {} disconnect() {}
  }
  runInNewContext(bundle.outputFiles[0].text, {document, window, fetch, localStorage, webapis: browser ? undefined : {avplay}, innerWidth: 1920, innerHeight: 1080, AbortSignal, AbortController, setTimeout, clearTimeout, queueMicrotask, IntersectionObserver});
  await tick();
  const key = async code => {const event = new window.Event('keydown'); event.keyCode = code; document.dispatchEvent(event); await tick();};
  if (feedOnly) return {document, window, requests, key, close: () => key(413), intersect: () => intersection?.([{isIntersecting: true}]), finishFeed: () => finishFeed?.(), finishInitialFeed: () => finishInitialFeed?.()};
  document.querySelector('.card').dispatchEvent(new window.Event('click'));
  await tick();
  if (!reading && !timecode) {
    document.querySelector('.video-row').dispatchEvent(new window.Event('click'));
    await tick();
  }
  return {document, window, calls, requests, previewRequests, resumeRequests, progressRequests, key, close: () => key(413), position: seconds => {if (browser) {htmlVideo.currentTime = seconds; htmlVideo.ontimeupdate?.();} else listener.oncurrentplaytime(seconds * 1000);}, end: () => listener.onstreamcompleted(), runtimeError: () => {if (browser) htmlVideo.onerror(); else listener.onerror();}, setDuration: seconds => {playbackDuration = seconds;}, setResumePosition: seconds => {resumePosition = seconds;}, finishProgress: () => {for (const request of progressRequests) request.finish?.();}};
}

test('Back restores the same channel cards, focus, scroll and pagination after reading a post', async () => {
  const posts = Array.from({length: 30}, (_, index) => ({id: `post-${index}`, blog: 'test-author', title: `Пост ${index}`, videos: [], publishedAt: 1790000000 - index}));
  const pages = {'': {items: posts, nextOffset: 'older'}, older: {items: [{...posts[0], id: 'post-30', publishedAt: 1789999900}], nextOffset: 'oldest'}, oldest: {items: [{...posts[0], id: 'post-31', publishedAt: 1789999800}], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true, reading: true});
  await ui.document.getElementById('authors').onclick();
  ui.document.querySelector('.author-card').dispatchEvent(new ui.window.Event('click')); await tick();
  ui.intersect(); await tick();
  const cards = [...ui.document.querySelectorAll('.card')];
  const selected = cards[12]; selected.focus(); ui.window.scrollTo(0, 1450);
  selected.dispatchEvent(new ui.window.Event('click')); await tick();
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 31);
  assert.equal(ui.document.querySelectorAll('.card')[12], selected);
  assert.equal(ui.document.activeElement === selected, true);
  assert.equal(ui.window.scrollY, 1450);
  assert.equal(ui.requests.filter(path => path === '/api/blog/test-author').length, 1);
  ui.intersect(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 32);
  assert.equal(ui.requests.filter(path => path === '/api/blog/test-author?offset=oldest').length, 1);
});

test('a cached feed keeps its card and viewport after video, post and Back', async () => {
  const posts = Array.from({length: 30}, (_, index) => ({id: `post-${index}`, blog: 'test-author', title: `Пост ${index}`, videos: [], publishedAt: 1790000000 - index}));
  const ui = await screen({pages: {'': {items: posts, nextOffset: null}}, feedOnly: true});
  const selected = ui.document.querySelectorAll('.card')[18]; selected.focus(); ui.window.scrollTo(0, 1900);
  selected.dispatchEvent(new ui.window.Event('click')); await tick();
  const video = ui.document.querySelector('.video-row'); video.focus(); ui.window.scrollTo(0, 320);
  video.dispatchEvent(new ui.window.Event('click')); await tick();
  ui.window.scrollTo(0, 0);
  await ui.close();
  assert.equal(ui.document.activeElement === video, true);
  assert.equal(ui.window.scrollY, 320);
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  assert.equal(ui.document.activeElement === selected, true);
  assert.equal(ui.window.scrollY, 1900);
  assert.equal(ui.requests.filter(path => path === '/api/feed').length, 1);
});

test('all post paragraphs and inline images render immediately in their original order', async () => {
  const ui = await screen({reading: true, body: [
    {type: 'text', text: 'Первый абзац\n\nВторой абзац'},
    {type: 'image', url: 'https://images.example/first.jpg', title: 'Первая иллюстрация'},
    {type: 'text', text: 'Третий абзац\n\nЧетвёртый абзац'},
    {type: 'image', url: 'https://images.example/second.jpg', title: 'Вторая иллюстрация'},
    {type: 'text', text: 'Последний абзац без сокращения'},
  ]});
  const article = ui.document.querySelector('.post-body');
  assert.deepEqual([...article.children].map(node => node.tagName), ['P', 'P', 'IMG', 'P', 'P', 'IMG', 'P']);
  assert.equal(article.lastElementChild.textContent, 'Последний абзац без сокращения');
  assert.deepEqual([...article.querySelectorAll('img')].map(node => node.alt), ['Первая иллюстрация', 'Вторая иллюстрация']);
  assert.equal(article.querySelector('[hidden], details, button'), null);
  assert.doesNotMatch(article.textContent, /Читать полностью/);
});

test('Back resumes pagination interrupted by opening a post without duplicate requests or a stuck button', async () => {
  const posts = Array.from({length: 30}, (_, index) => ({id: `post-${index}`, blog: 'test-author', title: `Пост ${index}`, videos: []}));
  const pages = {'': {items: posts, nextOffset: 'older'}, older: {items: [{...posts[0], id: 'post-30'}], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true, reading: true, stallFeed: true});
  ui.intersect(); await tick();
  const selected = ui.document.querySelectorAll('.card')[12]; selected.focus();
  selected.dispatchEvent(new ui.window.Event('click')); await tick();
  ui.finishFeed(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 0);
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  const more = ui.document.querySelector('.more');
  assert.equal(more.disabled, false);
  more.dispatchEvent(new ui.window.Event('click')); await tick();
  ui.finishFeed(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 31);
  assert.equal(ui.requests.filter(path => path === '/api/feed?offset=older').length, 2);
  assert.equal(ui.document.activeElement === ui.document.querySelector('.card:last-child'), true);
});

test('a pending page can finish after returning to its original screen', async () => {
  const posts = Array.from({length: 30}, (_, index) => ({id: `post-${index}`, blog: 'test-author', title: `Пост ${index}`, videos: []}));
  const pages = {'': {items: posts, nextOffset: 'older'}, older: {items: [{...posts[0], id: 'post-30'}], nextOffset: 'last'}, last: {items: [], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true, reading: true, stallFeed: true});
  ui.intersect(); await tick();
  const selected = ui.document.querySelectorAll('.card')[12]; selected.focus();
  selected.dispatchEvent(new ui.window.Event('click')); await tick();
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  assert.equal(ui.document.querySelector('.more').disabled, true);
  ui.intersect(); await tick();
  assert.equal(ui.requests.filter(path => path === '/api/feed?offset=older').length, 1);
  ui.finishFeed(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 31);
  assert.equal(ui.document.querySelector('.more').disabled, false);
  assert.equal(ui.document.activeElement === selected, true);
});

test('Back restores the clicked card even when the browser does not focus buttons on mouse click', async () => {
  const posts = Array.from({length: 3}, (_, index) => ({id: `post-${index}`, blog: 'test-author', title: `Пост ${index}`, videos: []}));
  const ui = await screen({pages: {'': {items: posts, nextOffset: null}}, feedOnly: true, reading: true});
  const selected = ui.document.querySelectorAll('.card')[1];
  assert.equal(ui.document.activeElement === selected, false);
  selected.dispatchEvent(new ui.window.Event('click')); await tick();
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  assert.equal(ui.document.activeElement === selected, true);
});

test('Back closes the native player locally even while the progress network request is stalled', async () => {
  const ui = await screen({stallProgress: true});
  ui.position(5); await tick();
  ui.close();
  await tick();
  assert.equal(ui.document.getElementById('playback').hidden, true);
  assert.equal(ui.calls.at(-1)[0], 'close');
  ui.finishProgress(); await tick();
});

test('timeline shows a cached frame honestly while loading the exact selection, and OK seeks exactly', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallPreview: true});
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  ui.position(20); await tick(); timeline.focus();
  t.mock.timers.tick(250); await tick(); ui.previewRequests[0].finish(); await tick();
  const first = panel.querySelector('img').src;
  timeline.value = '50'; timeline.oninput();
  assert.equal(panel.querySelector('img').hidden, false);
  assert.equal(panel.querySelector('img').src, first);
  assert.match(panel.textContent, /0:50.*Кадр 0:20/);
  assert.doesNotMatch(panel.textContent, /кэш|cache/i);
  assert.equal(ui.previewRequests.length, 1);
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  t.mock.timers.tick(250); await tick(); ui.previewRequests[1].finish(); await tick();
  assert.notEqual(panel.querySelector('img').src, first);
  assert.match(panel.textContent, /^0:50/);
  assert.doesNotMatch(panel.textContent, /кэш/i);
  const enter = new ui.window.Event('keydown'); enter.keyCode = 13; ui.document.dispatchEvent(enter); await tick();
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 50000]]);
  await ui.close();
});

test('scrubbing shows the selected chapter immediately across boundaries and never uses another video', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const body = [
    {type: 'timecode', seconds: 90, videoId: 'vid-1', description: 'Обсуждение результатов'},
    {type: 'timecode', seconds: 20, videoId: 'vid-1', description: 'Знакомство'},
    {type: 'timecode', seconds: 40, videoId: 'vid-10', description: 'Другой ролик'},
    {type: 'timecode', seconds: 130, videoId: 'vid-1', description: ''},
  ];
  const ui = await screen({body, twoVideos: true, stallPreview: true});
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus();
  assert.equal(panel.querySelector('.preview-chapter')?.hidden, true);
  timeline.value = '20'; timeline.oninput();
  assert.equal(panel.querySelector('.preview-chapter')?.textContent, 'Знакомство');
  t.mock.timers.tick(250); await tick(); ui.previewRequests[0].finish(); await tick();
  const frame = panel.querySelector('img').src;
  for (const [seconds, description] of [[89, 'Знакомство'], [90, 'Обсуждение результатов'], [129, 'Обсуждение результатов']]) {
    timeline.value = String(seconds); timeline.oninput();
    assert.equal(panel.querySelector('.preview-chapter')?.textContent, description);
    assert.equal(panel.querySelector('.preview-chapter')?.hidden, false);
    assert.equal(panel.querySelector('img').src, frame);
    assert.doesNotMatch(panel.textContent, /кэш|cache/i);
  }
  for (const seconds of [130, 179, 0]) {
    timeline.value = String(seconds); timeline.oninput();
    assert.equal(panel.querySelector('.preview-chapter')?.hidden, true);
    assert.equal(panel.querySelector('.preview-chapter')?.textContent, '');
  }
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  await ui.close();
});

test('timeline chapters use measured playback duration when Boosty has no duration metadata', async () => {
  const ui = await screen({metadataDuration: 0, body: [{type: 'timecode', seconds: 10, videoId: 'vid-1', description: 'Обсуждение результатов'}]});
  const timeline = ui.document.getElementById('timeline');
  timeline.focus(); timeline.value = '20'; timeline.oninput();
  assert.equal(timeline.disabled, false);
  assert.equal(timeline.max, 180);
  assert.equal(ui.document.querySelector('#timeline-preview .preview-chapter')?.textContent, 'Обсуждение результатов');
  await ui.close();
});

test('timeline segments cover the measured duration with sorted unique chapters of the exact video', async () => {
  const body = [
    {type: 'timecode', seconds: 135.375, videoId: 'vid-1'},
    {type: 'timecode', seconds: 45.125, videoId: 'vid-1'},
    {type: 'timecode', seconds: 90.25, videoId: 'vid-1'},
    {type: 'timecode', seconds: 45.125, videoId: 'vid-1'},
    {type: 'timecode', seconds: 10, videoId: 'vid-10'},
    {type: 'text', text: 'Описание публикации', seconds: 30, videoId: 'vid-1'},
    ...[0, -10, 180.5, 240, null, '60'].map(seconds => ({type: 'timecode', seconds, videoId: 'vid-1'})),
  ];
  const ui = await screen({body, metadataDuration: 0, playbackDuration: 180.5, twoVideos: true});
  const segments = [...ui.document.querySelectorAll('.timeline-segment')];
  assert.deepEqual(segments.map(segment => [segment.style.left, segment.style.width]), [
    ['0%', '25%'], ['25%', '25%'], ['50%', '25%'], ['75%', '25%'],
  ]);
  assert.equal(ui.document.getElementById('timeline-segments').getAttribute('aria-hidden'), 'true');
  assert.equal(ui.document.getElementById('timeline').disabled, false);
  assert.equal(ui.document.querySelectorAll('#timeline-segments button, #timeline-segments input').length, 0);
  await ui.close();
});

test('segmented timeline fills playback and scrub positions while Back preserves the current position', async () => {
  const ui = await screen({body: [
    {type: 'timecode', seconds: 60, videoId: 'vid-1', description: 'Вторая глава'},
    {type: 'timecode', seconds: 120, videoId: 'vid-1', description: 'Третья глава'},
  ]});
  const timeline = ui.document.getElementById('timeline');
  ui.position(30); await tick();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment-fill')].map(fill => fill.style.width), ['50%', '0%', '0%']);
  timeline.focus(); timeline.value = '90'; timeline.oninput();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment-fill')].map(fill => fill.style.width), ['100%', '50%', '0%']);
  assert.equal(ui.document.querySelector('#timeline-preview .preview-chapter').textContent, 'Вторая глава');
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment-fill')].map(fill => fill.style.width), ['50%', '0%', '0%']);
  timeline.focus(); timeline.value = '150'; timeline.oninput(); await timeline.onchange();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment-fill')].map(fill => fill.style.width), ['100%', '100%', '50%']);
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 150000]]);
  await ui.close();
});

test('timeline segments rebuild for another video and changed measured duration', async () => {
  const ui = await screen({twoVideos: true, body: [
    {type: 'timecode', seconds: 60, videoId: 'vid-1'},
    {type: 'timecode', seconds: 120, videoId: 'vid-1'},
    {type: 'timecode', seconds: 90, videoId: 'vid-10'},
  ]});
  assert.equal(ui.document.querySelectorAll('.timeline-segment').length, 3);
  await ui.close();
  ui.document.querySelectorAll('.video-row')[1].dispatchEvent(new ui.window.Event('click')); await tick();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment')].map(segment => [segment.style.left, segment.style.width]), [['0%', '50%'], ['50%', '50%']]);
  ui.setDuration(120);
  ui.document.getElementById('quality').onclick();
  ui.document.querySelectorAll('#choices-content button')[1].dispatchEvent(new ui.window.Event('click')); await tick();
  assert.deepEqual([...ui.document.querySelectorAll('.timeline-segment')].map(segment => [segment.style.left, segment.style.width]), [['0%', '75%'], ['75%', '25%']]);
  await ui.close();
});

test('timeline remains continuous without valid chapters and has no progress for unknown duration', async t => {
  for (const playbackDuration of [180, 0, Infinity, NaN]) {
    await t.test(String(playbackDuration), async () => {
      const ui = await screen({playbackDuration, body: [{type: 'timecode', seconds: 30, videoId: 'vid-10'}]});
      const segments = [...ui.document.querySelectorAll('.timeline-segment')];
      assert.deepEqual(segments.map(segment => [segment.style.left, segment.style.width]), [['0%', '100%']]);
      const timeline = ui.document.getElementById('timeline');
      assert.equal(timeline.disabled, playbackDuration !== 180);
      assert.equal(Number(timeline.max), playbackDuration === 180 ? 180 : 0);
      assert.equal(segments[0].querySelector('.timeline-segment-fill').style.width, '0%');
      await ui.close();
    });
  }
});

test('a chapter with no frame keeps its description and renders markup as literal text', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({body: [{type: 'timecode', seconds: 0, videoId: 'vid-1', description: '<script>chapter()</script>'}], previewError: true});
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus(); t.mock.timers.tick(250); await tick();
  assert.equal(panel.querySelector('.preview-chapter')?.textContent, '<script>chapter()</script>');
  assert.equal(panel.querySelector('script'), null);
  assert.match(panel.textContent, /Кадр недоступен/);
  timeline.value = '15'; timeline.oninput(); await timeline.onchange();
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 15000]]);
  await ui.close();
});

test('a cached timeline frame survives OK and refocusing without a network round trip', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(); ui.position(20); await tick();
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus(); t.mock.timers.tick(250); await tick();
  const first = panel.querySelector('img').src;
  await timeline.onchange(); timeline.focus();
  assert.equal(panel.querySelector('img').hidden, false);
  assert.equal(panel.querySelector('img').src, first);
  assert.doesNotMatch(panel.textContent, /Загружаем/);
  assert.equal(ui.requests.filter(path => path.endsWith('seconds=20')).length, 1);
  await ui.close();
});

test('remote Back cancels scrubbing without discarding a same-post cached frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(); ui.position(20); await tick();
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus(); t.mock.timers.tick(250); await tick();
  const first = panel.querySelector('img').src;
  const back = new ui.window.Event('keydown'); back.keyCode = 10009; ui.document.dispatchEvent(back); await tick();
  assert.equal(ui.document.getElementById('playback').hidden, false);
  assert.equal(panel.hidden, true);
  timeline.focus();
  assert.equal(panel.querySelector('img').hidden, false);
  assert.equal(panel.querySelector('img').src, first);
  t.mock.timers.tick(250); await tick();
  assert.equal(ui.requests.filter(path => path.endsWith('seconds=20')).length, 1);
  await ui.close();
});

test('switching quality on the same video retains a previously warmed timeline frame', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(); ui.position(20); await tick();
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus(); t.mock.timers.tick(250); await tick();
  const first = panel.querySelector('img').src;
  ui.document.getElementById('quality').focus(); ui.document.getElementById('quality').onclick();
  const source = [...ui.document.querySelectorAll('#choices-content button')].find(node => node.textContent === '1080p');
  source.dispatchEvent(new ui.window.Event('click')); await tick();
  timeline.focus();
  assert.equal(panel.querySelector('img').hidden, false);
  assert.equal(panel.querySelector('img').src, first);
  t.mock.timers.tick(250); await tick();
  assert.equal(ui.requests.filter(path => path.endsWith('seconds=20')).length, 1);
  await ui.close();
});

test('chapter focus shows a real frame and description without opening the player', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({timecode: true});
  ui.document.querySelector('.post-timecode').focus();
  t.mock.timers.tick(250); await tick();
  const panel = ui.document.querySelector('.chapter-preview');
  assert.equal(panel?.hidden, false);
  assert.match(panel.querySelector('img').src, /^data:image\/jpeg/);
  assert.match(panel.textContent, /1:30.*Обсуждение результатов/);
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')), ['/api/preview/test-author/post-1/content-17?seconds=90']);
  assert.equal(ui.calls.length, 0);
  ui.document.querySelector('.video-row').focus();
  assert.equal(panel.hidden, true);
});

test('chapter prefetch prioritizes nearby timecodes of the same video and displays them immediately', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const body = [
    {type: 'timecode', seconds: 20, videoId: 'vid-1', description: 'Начало'},
    {type: 'timecode', seconds: 70, videoId: 'vid-1', description: 'Результаты'},
    {type: 'timecode', seconds: 130, videoId: 'vid-1', description: 'Выводы'},
    {type: 'timecode', seconds: 30, videoId: 'vid-10', description: 'Другой ролик'},
  ];
  const ui = await screen({timecode: true, body, twoVideos: true});
  const chapters = ui.document.querySelectorAll('.post-timecode');
  chapters[0].focus(); t.mock.timers.tick(250); await tick();
  t.mock.timers.tick(500); await tick();
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')), [
    '/api/preview/test-author/post-1/content-17?seconds=20',
    '/api/preview/test-author/post-1/content-17?seconds=70',
    '/api/preview/test-author/post-1/content-17?seconds=130',
    '/api/preview/test-author/post-1/content-17?seconds=30',
    '/api/preview/test-author/post-1/content-17?seconds=10',
  ]);
  const panel = ui.document.querySelector('.chapter-preview'), first = panel.querySelector('img').src;
  assert.match(panel.textContent, /0:20.*Начало/);
  chapters[1].focus();
  assert.notEqual(panel.querySelector('img').src, first);
  assert.match(panel.textContent, /1:10.*Результаты/);
  assert.doesNotMatch(panel.textContent, /Загружаем/);
  assert.equal(ui.requests.filter(path => path.endsWith('seconds=70')).length, 1);
  assert.equal(ui.calls.length, 0);
  await ui.document.getElementById('feed').onclick();
});

test('timeline prefetch prepares exact neighboring positions without seeking until OK', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const body = [80, 140].map(seconds => ({type: 'timecode', seconds, videoId: 'vid-1', description: 'Глава'}));
  const ui = await screen({body}); ui.position(30); await tick();
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus(); t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')), [
    '/api/preview/test-author/post-1/content-17?seconds=30',
    '/api/preview/test-author/post-1/content-17?seconds=40',
    '/api/preview/test-author/post-1/content-17?seconds=20',
    '/api/preview/test-author/post-1/content-17?seconds=80',
    '/api/preview/test-author/post-1/content-17?seconds=140',
  ]);
  const first = panel.querySelector('img').src;
  const right = new ui.window.Event('keydown'); right.keyCode = 39; ui.document.dispatchEvent(right);
  assert.equal(Number(timeline.value), 40);
  assert.notEqual(panel.querySelector('img').src, first);
  assert.doesNotMatch(panel.textContent, /Загружаем/);
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  const enter = new ui.window.Event('keydown'); enter.keyCode = 13; ui.document.dispatchEvent(enter); await tick();
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 40000]]);
  await ui.close();
});

test('prefetch clamps timeline neighbors to real video positions', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(); const timeline = ui.document.getElementById('timeline');
  timeline.focus(); t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')), [
    '/api/preview/test-author/post-1/content-17?seconds=0',
    '/api/preview/test-author/post-1/content-17?seconds=10',
  ]);
  timeline.value = '179'; timeline.oninput(); t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')).slice(2), [
    '/api/preview/test-author/post-1/content-17?seconds=179',
    '/api/preview/test-author/post-1/content-17?seconds=169',
  ]);
  await ui.close();
});

test('hiding a reader aborts its background frame and stops prefetch', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({timecode: true, stallPreview: true});
  ui.document.querySelector('.post-timecode').focus(); t.mock.timers.tick(250); await tick();
  ui.previewRequests[0].finish(); await tick(); t.mock.timers.tick(500); await tick();
  assert.equal(ui.previewRequests.length, 2);
  Object.defineProperty(ui.document, 'hidden', {value: true, configurable: true});
  ui.document.dispatchEvent(new ui.window.Event('visibilitychange')); await tick();
  assert.equal(ui.previewRequests[1].signal.aborted, true);
  ui.previewRequests[1].finish(); await tick(); t.mock.timers.tick(500); await tick();
  assert.equal(ui.previewRequests.length, 2);
  assert.equal(ui.document.querySelector('.chapter-preview').hidden, true);
  await ui.document.getElementById('feed').onclick();
});

test('hidden playback cannot restart chapter previews when closing restores focus', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({timecode: true});
  const chapter = ui.document.querySelector('.post-timecode');
  chapter.dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.document.getElementById('playback').hidden, false);
  Object.defineProperty(ui.document, 'hidden', {value: true, configurable: true});
  ui.document.dispatchEvent(new ui.window.Event('visibilitychange')); await tick();
  assert.equal(ui.document.getElementById('playback').hidden, true);
  assert.equal(ui.document.activeElement === chapter, true);
  t.mock.timers.tick(250); await tick(); t.mock.timers.tick(500); await tick();
  assert.equal(ui.requests.some(path => path.startsWith('/api/preview/')), false);
  assert.equal(ui.document.querySelector('.chapter-preview').hidden, true);
  await ui.document.getElementById('feed').onclick();
});

test('two chapters and similar video identities retain their own frame, caption and request', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const chapters = [
    {type: 'timecode', title: '0:20', seconds: 20, videoId: 'vid-1', description: 'Первая глава'},
    {type: 'timecode', title: '0:30', seconds: 30, videoId: 'vid-1', description: 'Вторая глава'},
    {type: 'timecode', title: '0:20', seconds: 20, videoId: 'vid-10', description: 'Другой ролик'},
  ];
  const ui = await screen({timecode: true, body: chapters, twoVideos: true});
  const controls = [...ui.document.querySelectorAll('.post-timecode')];
  assert.equal(controls.length, 3);
  const images = [];
  for (const chapter of controls) {
    chapter.focus(); t.mock.timers.tick(250); await tick();
    const panel = ui.document.querySelector('.chapter-preview');
    assert.equal(panel.hidden, false); images.push(panel.querySelector('img').src);
    assert.match(panel.textContent, new RegExp(chapter.querySelector('.post-timecode-description').textContent));
  }
  assert.equal(new Set(images).size, 3);
  assert.deepEqual(ui.requests.filter(path => path.startsWith('/api/preview/')), [
    '/api/preview/test-author/post-1/content-17?seconds=20',
    '/api/preview/test-author/post-1/content-17?seconds=30',
    '/api/preview/test-author/post-1/content-170?seconds=20',
  ]);
  assert.equal(ui.calls.length, 0);
  await ui.document.getElementById('feed').onclick();
});

test('changing posts aborts a pending chapter frame and rejects its late response', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const posts = [1, 2].map(number => ({id: `post-${number}`, blog: 'test-author', title: `Пост ${number}`, videos: []}));
  const ui = await screen({timecode: true, stallPreview: true, pages: {'': {items: posts, nextOffset: null}}});
  ui.document.querySelector('.post-timecode').focus(); t.mock.timers.tick(250); await tick();
  assert.equal((ui.previewRequests || []).length, 1);
  const old = ui.previewRequests[0];
  await ui.document.getElementById('feed').onclick();
  assert.equal(old.signal.aborted, true);
  ui.document.querySelectorAll('.card')[1].dispatchEvent(new ui.window.Event('click')); await tick();
  ui.document.querySelector('.post-timecode').focus(); t.mock.timers.tick(250); await tick();
  old.finish(); await tick();
  const panel = ui.document.querySelector('.chapter-preview');
  assert.equal(panel.querySelector('img').hasAttribute('src'), false);
  assert.match(panel.textContent, /Загружаем кадр/);
  ui.previewRequests[1].finish(); await tick();
  assert.match(panel.querySelector('img').src, /^data:image\/jpeg/);
  assert.match(ui.previewRequests[1].path, /post-2\/content-17/);
  await ui.document.getElementById('feed').onclick();
});

test('timeline frame follows selection, stays bounded and is not requested by playback progress', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(); ui.position(30); await tick();
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.getBoundingClientRect = () => ({width: 1000});
  if (panel) panel.getBoundingClientRect = () => ({width: 320});
  for (const keyCode of [38, 39, 39]) { const event = new ui.window.Event('keydown'); event.keyCode = keyCode; ui.document.dispatchEvent(event); }
  t.mock.timers.tick(250); await tick();
  assert.equal(panel?.hidden, false);
  assert.match(panel.querySelector('img').src, /^data:image\/jpeg/);
  assert.equal(ui.requests.filter(path => path.startsWith('/api/preview/')).length, 1);
  t.mock.timers.tick(100); await tick();
  const prepared = ui.requests.filter(path => path.startsWith('/api/preview/')).length;
  ui.position(60); await tick(); t.mock.timers.tick(250); await tick();
  assert.equal(Number(timeline.value), 50);
  assert.equal(ui.requests.filter(path => path.startsWith('/api/preview/')).length, prepared);
  timeline.value = '0'; timeline.oninput(); assert.equal(panel.style.left, '0px');
  timeline.value = '180'; timeline.oninput(); assert.equal(panel.style.left, '680px');
  const enter = new ui.window.Event('keydown'); enter.keyCode = 13; ui.document.dispatchEvent(enter); await tick();
  assert.equal(panel.hidden, true);
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 179500]]);
  await ui.close();
});

test('unavailable previews do not prevent a browser timeline seek', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({browser: true, previewError: true});
  const timeline = ui.document.getElementById('timeline'); timeline.focus(); timeline.value = '40'; timeline.oninput();
  t.mock.timers.tick(250); await tick();
  assert.match(ui.document.getElementById('timeline-preview')?.textContent || '', /Кадр недоступен/);
  await timeline.onchange();
  assert.equal(ui.document.getElementById('browser-video').currentTime, 40);
  await ui.close();
});

test('leaving a timeline cancels its frame and a missing content id remains nonfatal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({contentId: null});
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus();
  assert.match(panel.textContent, /Кадр недоступен/);
  assert.equal(timeline.disabled, false);
  ui.document.getElementById('playback').focus();
  assert.equal(panel.hidden, true);
  t.mock.timers.tick(250); await tick();
  assert.equal(ui.requests.some(path => path.startsWith('/api/preview/')), false);
  timeline.focus(); timeline.dispatchEvent(new ui.window.Event('blur'));
  assert.equal(panel.hidden, true);
  await ui.close();
});

test('timeline focus previews an absolute position and OK commits one native seek', async () => {
  const ui = await screen();
  ui.position(30); await tick();
  for (const keyCode of [38, 39, 39]) {
    const event = new ui.window.Event('keydown'); event.keyCode = keyCode; ui.document.dispatchEvent(event);
  }
  const timeline = ui.document.getElementById('timeline');
  assert.equal(ui.document.activeElement === timeline, true);
  assert.equal(Number(timeline.value), 50);
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  const enter = new ui.window.Event('keydown'); enter.keyCode = 13; ui.document.dispatchEvent(enter);
  await tick();
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 50000]]);
  assert.equal(ui.document.getElementById('rewind'), null);
  assert.equal(ui.document.getElementById('forward'), null);
  await ui.close();
});

test('Back cancels a pending timeline selection without closing the video', async () => {
  const ui = await screen();
  ui.position(30); await tick();
  for (const keyCode of [38, 39, 27]) {
    const event = new ui.window.Event('keydown'); event.keyCode = keyCode; ui.document.dispatchEvent(event);
  }
  await tick();
  assert.equal(ui.document.getElementById('playback').hidden, false);
  assert.equal(Number(ui.document.getElementById('timeline').value), 30);
  assert.equal(ui.calls.filter(([name]) => name === 'seek').length, 0);
  await ui.close();
});

test('native seek failures are shown in the visible player instead of behind it', async () => {
  const ui = await screen({seekError: true});
  for (const keyCode of [38, 39, 13]) {
    const event = new ui.window.Event('keydown'); event.keyCode = keyCode; ui.document.dispatchEvent(event);
  }
  await tick();
  assert.match(ui.document.getElementById('player-status').textContent, /перемот|качество/i);
  await ui.close();
});

test('a post timecode opens its video at the exact linked timestamp', async () => {
  const ui = await screen({timecode: true});
  const chapter = ui.document.querySelector('.post-timecode');
  assert.ok(chapter);
  assert.equal(chapter.querySelector('.post-timecode-time')?.textContent, '1:30');
  assert.equal(chapter.querySelector('.post-timecode-description')?.textContent, 'Обсуждение результатов');
  chapter.dispatchEvent(new ui.window.Event('click')); await tick();
  assert.ok(ui.calls.some(([name, ms]) => name === 'seek' && ms === 90000));
  assert.equal(ui.document.getElementById('playback').hidden, false);
  await ui.close();
});

test('feed merges pages newest-first without duplicate cards or losing remote focus', async () => {
  const posts = Array.from({length: 30}, (_, index) => ({id: `post-${index}`, blog: 'test-author',
    title: `Публикация ${index}`, publishedAt: 1790000000 - index * 60, body: [], videos: [], locked: false}));
  const pages = {'': {items: [...posts].reverse(), nextOffset: 'older'}, older: {items: [posts[29],
    {id: 'post-new', blog: 'test-author', title: 'Новая публикация', publishedAt: 1790000060, body: [], videos: [], locked: false}], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true, stallFeed: true});
  const before = [...ui.document.querySelectorAll('.card')];
  assert.match(before[0].textContent, /Публикация 0/);
  assert.ok(before[0].querySelector('time')?.getAttribute('datetime'));
  const selected = before[28]; selected.focus(); ui.intersect(); ui.intersect(); await tick();
  assert.equal(ui.requests.filter(path => path === '/api/feed?offset=older').length, 1);
  ui.finishFeed(); await tick();
  const cards = [...ui.document.querySelectorAll('.card')];
  assert.equal(cards.length, 31);
  assert.match(cards[0].textContent, /Новая публикация/);
  assert.equal(ui.document.activeElement === selected, true);
  ui.intersect(); await tick();
  assert.equal(ui.requests.filter(path => path === '/api/feed?offset=older').length, 1);
});

test('automatic pagination stops on failure and allows an explicit retry without losing existing posts', async () => {
  const item = {id: 'p1', blog: 'test-author', title: 'Сохранённая публикация', publishedAt: 1790000000, videos: []};
  const pages = {'': {items: [item], nextOffset: 'older'}, older: new Error('Временная ошибка ленты')};
  const ui = await screen({pages, feedOnly: true});
  ui.intersect(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 1);
  assert.match(ui.document.getElementById('status').textContent, /Не удалось выполнить запрос/);
  const attempts = ui.requests.filter(path => path === '/api/feed?offset=older').length;
  ui.intersect(); ui.intersect(); await tick();
  assert.equal(ui.requests.filter(path => path === '/api/feed?offset=older').length, attempts);
  pages.older = {items: [{...item, id: 'p2', publishedAt: 1789990000}], nextOffset: null};
  ui.document.querySelector('.more').dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 2);
  assert.equal(ui.document.querySelector('.more'), null);
});

test('a late pagination response cannot add cards after navigating to a fresh feed', async () => {
  const item = {id: 'p1', blog: 'test-author', title: 'Исходная публикация', publishedAt: 1790000000, videos: []};
  const items = Array.from({length: 30}, (_, index) => ({...item, id: `p${index}`}));
  const pages = {'': {items, nextOffset: 'older'}, older: {items: [{...item, id: 'stale'}], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true, stallFeed: true});
  ui.intersect(); await tick();
  ui.document.getElementById('feed').dispatchEvent(new ui.window.Event('click')); await tick();
  ui.finishFeed(); await tick();
  assert.equal(ui.document.querySelectorAll('.card').length, 30);
});

test('stale initial feed responses never move focus in the newer screen', async () => {
  const items = Array.from({length: 30}, (_, index) => ({id: `p${index}`, blog: 'test-author', title: `Пост ${index}`, videos: []}));
  const ui = await screen({pages: {'': {items, nextOffset: null}}, feedOnly: true, stallInitialFeed: true});
  ui.document.getElementById('feed').dispatchEvent(new ui.window.Event('click')); await tick();
  const selected = ui.document.querySelectorAll('.card')[12]; selected.focus();
  ui.finishInitialFeed(); await tick();
  assert.equal(ui.document.activeElement === selected, true);
});

test('manual pagination restores remote focus after replacing the focused load button', async () => {
  const items = Array.from({length: 30}, (_, index) => ({id: `p${index}`, blog: 'test-author', title: `Пост ${index}`, publishedAt: 1790000000 - index, videos: []}));
  const pages = {'': {items, nextOffset: 'older'}, older: {items: [{...items[0], id: 'p30', title: 'Следующая страница', publishedAt: 1789999900}], nextOffset: null}};
  const ui = await screen({pages, feedOnly: true});
  const more = ui.document.querySelector('.more'); more.focus();
  more.dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.document.activeElement.classList.contains('card'), true);
  assert.match(ui.document.activeElement.textContent, /Следующая страница/);
});

test('a post without videos opens a readable article and never interprets text as HTML', async () => {
  const ui = await screen({reading: true});
  const article = ui.document.querySelector('.post-body');
  assert.ok(article);
  assert.match(article.textContent, /Текст поста <script>danger\(\)<\/script>/);
  assert.equal(article.querySelector('script'), null);
  assert.equal(article.querySelector('img').getAttribute('src'), 'https://images.example/photo.jpg');
  assert.equal(ui.document.querySelector('.video-row'), null);
  assert.equal(ui.document.getElementById('playback').hidden, true);
});

test('the remote scrolls a focused article before moving to another control', async () => {
  const ui = await screen({reading: true});
  const article = ui.document.querySelector('.post-body');
  Object.defineProperties(article, {scrollHeight: {value: 3000}, clientHeight: {value: 600},
    scrollTop: {value: 0, writable: true}});
  Object.defineProperty(ui.document, 'activeElement', {value: article});
  const down = new ui.window.Event('keydown'); down.keyCode = 40;
  ui.document.dispatchEvent(down);
  assert.equal(article.scrollTop, 378);
});

test('a browser without native HLS starts an available MP4 source', async () => {
  const ui = await screen({browser: true});
  assert.equal(ui.document.getElementById('browser-video').src, 'https://video.example/a.mp4');
  assert.equal(ui.document.getElementById('quality').getAttribute('aria-label'), 'Качество: 1080p');
  await ui.close();
});

test('reopening a video from the same post resumes its successfully saved position', async () => {
  const ui = await screen();
  ui.position(120); await tick();
  await ui.close();
  ui.document.querySelector('.video-row').dispatchEvent(new ui.window.Event('click'));
  await tick();
  assert.ok(ui.calls.some(([name, ms]) => name === 'seek' && ms === 120000));
  await ui.close();
});

test('ordinary video openings fetch fresh resume positions instead of stale post metadata', async t => {
  for (const browser of [false, true]) {
    await t.test(browser ? 'browser' : 'native', async () => {
      const ui = await screen({browser, cachedPosition: 15, resumePosition: 70});
      const resumePath = '/api/progress/test-author/post-1/vid-1';
      assert.equal(ui.requests.filter(path => path === resumePath).length, 1);
      assert.equal(Number(ui.document.getElementById('timeline').value), 70);
      if (browser) assert.equal(ui.document.getElementById('browser-video').currentTime, 70);
      else assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 70000]]);
      await ui.close();
      ui.setResumePosition(0);
      ui.document.querySelector('.video-row').dispatchEvent(new ui.window.Event('click')); await tick();
      assert.equal(ui.requests.filter(path => path === resumePath).length, 2);
      assert.equal(Number(ui.document.getElementById('timeline').value), 0);
      await ui.close();
    });
  }
});

test('an explicit zero chapter bypasses the resume lookup used by ordinary openings', async () => {
  const ui = await screen({resumePosition: 80, body: [{type: 'timecode', seconds: 0, videoId: 'vid-1', description: 'Начало'}]});
  assert.equal(ui.requests.filter(path => path.startsWith('/api/progress/')).length, 1);
  await ui.close();
  ui.document.querySelector('.post-timecode').dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.requests.filter(path => path.startsWith('/api/progress/')).length, 1);
  assert.equal(Number(ui.document.getElementById('timeline').value), 0);
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 80000]]);
  await ui.close();
});

test('successful resume opening restores remote focus to an enabled playback control', async () => {
  const ui = await screen({resumePosition: 40});
  assert.equal(ui.document.activeElement === ui.document.getElementById('playback'), true);
  await ui.close();
});

test('closing during resume lookup aborts opening and never overwrites progress with zero', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallResume: true, resumePosition: 60});
  assert.equal(ui.calls.filter(([name]) => name === 'open').length, 0);
  assert.equal(ui.resumeRequests.length, 1);
  await ui.close();
  assert.equal(ui.resumeRequests[0].signal.aborted, true);
  ui.resumeRequests[0].finish(); await tick();
  assert.equal(ui.document.getElementById('playback').hidden, true);
  assert.equal(ui.calls.filter(([name]) => name === 'open').length, 0);
  assert.equal(ui.progressRequests.length, 0);
});

test('a late resume response cannot replace a newer opening', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallResume: true, twoVideos: true});
  assert.equal(ui.resumeRequests.length, 1);
  await ui.close();
  ui.document.querySelectorAll('.video-row')[1].dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.resumeRequests.length, 2);
  assert.equal(ui.resumeRequests[1].path, '/api/progress/test-author/post-1/vid-10');
  ui.resumeRequests[1].finish(90); await tick();
  ui.resumeRequests[0].finish(120); await tick();
  assert.equal(ui.calls.filter(([name]) => name === 'open').length, 1);
  assert.deepEqual(ui.calls.filter(([name]) => name === 'seek'), [['seek', 90000]]);
  assert.equal(ui.document.getElementById('video-title').textContent, 'Другой ролик');
  await ui.close();
});

test('closing sends the final progress point while an older save is still busy', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallProgress: true});
  ui.position(20); await tick(); ui.position(25); await tick();
  const closing = ui.close(); await tick();
  assert.equal(ui.document.getElementById('playback').hidden, true);
  assert.deepEqual(ui.progressRequests.map(request => request.body), [{videoId: 'vid-1', seconds: 20}, {videoId: 'vid-1', seconds: 25}]);
  ui.progressRequests[1].finish(); await tick(); ui.progressRequests[0].finish(); await closing;
});

test('pause saves the exact position below the periodic save threshold', async () => {
  const ui = await screen();
  ui.position(10); await tick();
  assert.equal(ui.progressRequests.length, 0);
  await ui.key(32);
  assert.deepEqual(ui.progressRequests.map(request => request.body), [{videoId: 'vid-1', seconds: 10}]);
  await ui.close();
});

test('older save acknowledgements never move the periodic save baseline backwards', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallProgress: true});
  ui.position(20); await tick(); ui.position(25); await tick();
  await ui.key(32);
  assert.equal(ui.progressRequests.length, 2);
  ui.progressRequests[1].finish(); await tick(); ui.progressRequests[0].finish(); await tick();
  ui.position(35); await tick();
  assert.deepEqual(ui.progressRequests.map(request => request.body), [{videoId: 'vid-1', seconds: 20}, {videoId: 'vid-1', seconds: 25}]);
  const closing = ui.close(); await tick(); ui.finishProgress(); await closing;
});

test('playback completion saves its latest measured point', async () => {
  const ui = await screen();
  ui.position(12); await tick(); ui.end(); await tick();
  assert.deepEqual(ui.progressRequests.map(request => request.body), [{videoId: 'vid-1', seconds: 12}]);
  await ui.close();
});

test('access-denied resume lookup never falls back to stale post progress or starts playback', async () => {
  const ui = await screen({cachedPosition: 70, resumeError: 403});
  assert.equal(ui.calls.filter(([name]) => name === 'open').length, 0);
  assert.equal(ui.progressRequests.length, 0);
  assert.match(ui.document.getElementById('player-status').textContent, /Не удалось выполнить запрос/);
  await ui.close();
  assert.equal(ui.progressRequests.length, 0);
});

test('resume lookup rejects malformed positions before opening a source', async t => {
  for (const resumePosition of [null, '17', -1]) {
    await t.test(String(resumePosition), async () => {
      const ui = await screen({resumePosition});
      assert.equal(ui.calls.filter(([name]) => name === 'open').length, 0);
      assert.match(ui.document.getElementById('player-status').textContent, /неожиданный ответ/);
      await ui.close();
      assert.equal(ui.progressRequests.length, 0);
    });
  }
});

test('a progress failure remains visible while the player is paused', async () => {
  const ui = await screen({progressError: true});
  ui.position(10); await tick(); await ui.key(32); await tick();
  assert.match(ui.document.getElementById('player-status').textContent, /Позиция просмотра пока не сохранена/);
  await ui.close();
});

test('compact player keeps only time and an accessible SVG quality gear without remote hints', async () => {
  const ui = await screen();
  const playback = ui.document.getElementById('playback'), gear = ui.document.getElementById('quality');
  assert.equal(playback.querySelectorAll('button').length, 1);
  assert.equal(playback.querySelector('#toggle, #close-player, #player-language, .key-hint'), null);
  assert.equal(gear.textContent.trim(), '');
  assert.ok(gear.querySelector('svg path'));
  assert.equal(gear.getAttribute('aria-label'), 'Качество: Авто');
  assert.equal(gear.getAttribute('title'), 'Качество: Авто');
  assert.ok(ui.document.querySelector('main footer'));
  assert.ok(ui.document.getElementById('language'));
  await ui.close();
});

test('quality gear retains its SVG while labels follow language and selected quality', async () => {
  const ui = await screen(), gear = ui.document.getElementById('quality');
  const icon = gear.querySelector('svg');
  assert.ok(icon);
  ui.document.getElementById('language').dispatchEvent(new ui.window.Event('click'));
  assert.equal(gear.getAttribute('aria-label'), 'Quality: Auto');
  assert.equal(gear.getAttribute('title'), 'Quality: Auto');
  gear.onclick(); ui.document.querySelectorAll('#choices-content button')[1].dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(gear.getAttribute('aria-label'), 'Quality: 1080p');
  assert.equal(gear.getAttribute('title'), 'Quality: 1080p');
  assert.equal(gear.querySelector('svg'), icon);
  assert.equal(gear.textContent.trim(), '');
  await ui.close();
});

test('player controls hide at exactly five idle seconds without progress extending the deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const browser of [false, true]) {
    await t.test(browser ? 'browser' : 'native', async () => {
      const ui = await screen({browser}), panel = ui.document.querySelector('.player-shade');
      t.mock.timers.tick(4999); ui.position(20); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      t.mock.timers.tick(1); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), true);
      assert.equal(panel.getAttribute('aria-hidden'), 'true');
      assert.equal(panel.hasAttribute('inert'), true);
      assert.equal(ui.document.getElementById('timeline').tabIndex, -1);
      assert.equal(ui.document.getElementById('quality').tabIndex, -1);
      assert.equal(ui.document.activeElement === ui.document.getElementById('playback'), true);
      await ui.close();
    });
  }
});

test('a failed progress save does not permanently pin controls after their first hide', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const browser of [false, true]) {
    await t.test(browser ? 'browser' : 'native', async () => {
      const ui = await screen({browser, progressError: true}), panel = ui.document.querySelector('.player-shade');
      t.mock.timers.tick(5000); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), true);
      ui.position(15); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      assert.match(ui.document.getElementById('player-status').textContent, /Позиция просмотра пока не сохранена/);
      t.mock.timers.tick(4999); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      t.mock.timers.tick(1); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), true);
      for (const code of [38, 40, 32]) {
        await ui.key(code);
        assert.equal(panel.classList.contains('controls-hidden'), false);
        t.mock.timers.tick(5000); await tick();
        assert.equal(panel.classList.contains('controls-hidden'), true);
      }
      await ui.close();
    });
  }
});

test('keyboard pointer touch and focus activity restart the five second idle timer', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const activity of ['keyboard', 'pointermove', 'pointerdown', 'touchstart', 'wheel', 'focus']) {
    await t.test(activity, async () => {
      const ui = await screen(), panel = ui.document.querySelector('.player-shade');
      t.mock.timers.tick(4000);
      if (activity === 'keyboard') await ui.key(38);
      else if (activity === 'focus') ui.document.getElementById('quality').focus();
      else ui.document.getElementById('playback').dispatchEvent(new ui.window.Event(activity, {bubbles: true}));
      t.mock.timers.tick(4999); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      t.mock.timers.tick(1); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), true);
      await ui.close();
    });
  }
});

test('quality dialog pins controls and closing it starts a fresh five second deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(), panel = ui.document.querySelector('.player-shade');
  t.mock.timers.tick(4000); ui.document.getElementById('quality').onclick();
  t.mock.timers.tick(20000); await tick();
  assert.equal(panel.classList.contains('controls-hidden'), false);
  await ui.key(27);
  assert.equal(ui.document.getElementById('choices').open, false);
  t.mock.timers.tick(4999); await tick(); assert.equal(panel.classList.contains('controls-hidden'), false);
  t.mock.timers.tick(1); await tick(); assert.equal(panel.classList.contains('controls-hidden'), true);
  await ui.close();
});

test('wheel wakes hidden player controls and starts a fresh five second deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(), panel = ui.document.querySelector('.player-shade');
  t.mock.timers.tick(5000); await tick();
  assert.equal(panel.classList.contains('controls-hidden'), true);
  ui.document.getElementById('playback').dispatchEvent(new ui.window.Event('wheel', {bubbles: true}));
  assert.equal(panel.classList.contains('controls-hidden'), false);
  assert.equal(panel.hasAttribute('inert'), false);
  t.mock.timers.tick(4999); await tick();
  assert.equal(panel.classList.contains('controls-hidden'), false);
  t.mock.timers.tick(1); await tick();
  assert.equal(panel.classList.contains('controls-hidden'), true);
  await ui.close();
});

test('hidden gear cannot keep focus or open on a waking OK and arrows restore timeline control', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(), panel = ui.document.querySelector('.player-shade'), gear = ui.document.getElementById('quality');
  gear.focus(); t.mock.timers.tick(5000); await tick();
  gear.focus();
  assert.equal(ui.document.activeElement === ui.document.getElementById('playback'), true);
  await ui.key(13);
  assert.equal(panel.classList.contains('controls-hidden'), false);
  assert.equal(ui.document.getElementById('choices').open, false);
  assert.equal(ui.calls.filter(([name]) => name === 'pause').length, 1);
  assert.equal(panel.hasAttribute('inert'), false);
  t.mock.timers.tick(5000); await tick(); await ui.key(38);
  assert.equal(ui.document.activeElement === ui.document.getElementById('timeline'), true);
  assert.equal(panel.classList.contains('controls-hidden'), false);
  await ui.key(40);
  assert.equal(ui.document.activeElement === gear, true);
  await ui.key(13);
  assert.equal(ui.document.getElementById('choices').open, true);
  await ui.close();
});

test('neutral OK space and media keys pause playback without a pause button', async () => {
  const ui = await screen();
  ui.document.getElementById('playback').focus();
  for (const code of [13, 32, 415, 19, 10252]) await ui.key(code);
  assert.equal(ui.calls.filter(([name]) => name === 'pause').length, 3);
  assert.equal(ui.calls.filter(([name]) => name === 'play').length, 3);
  assert.equal(ui.document.getElementById('choices').open, false);
  await ui.close();
});

test('video surface click pauses but bubbled timeline and gear clicks never pause', async () => {
  const ui = await screen();
  ui.document.getElementById('native-video').dispatchEvent(new ui.window.Event('click', {bubbles: true})); await tick();
  assert.equal(ui.calls.filter(([name]) => name === 'pause').length, 1);
  ui.document.getElementById('timeline').dispatchEvent(new ui.window.Event('click', {bubbles: true})); await tick();
  ui.document.getElementById('quality').dispatchEvent(new ui.window.Event('click', {bubbles: true})); await tick();
  assert.equal(ui.calls.filter(([name]) => name === 'pause').length, 1);
  assert.equal(ui.document.getElementById('choices').open, true);
  await ui.close();
});

test('closing and reopening cancels the old idle timer and pending resume remains visible', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({stallResume: true}), panel = ui.document.querySelector('.player-shade');
  t.mock.timers.tick(6000); await tick();
  assert.equal(panel.classList.contains('controls-hidden'), false);
  ui.resumeRequests[0].finish(20); await tick();
  t.mock.timers.tick(4000); await ui.close();
  ui.document.querySelector('.video-row').dispatchEvent(new ui.window.Event('click')); await tick();
  ui.resumeRequests[1].finish(30); await tick();
  t.mock.timers.tick(4999); await tick(); assert.equal(panel.classList.contains('controls-hidden'), false);
  t.mock.timers.tick(1); await tick(); assert.equal(panel.classList.contains('controls-hidden'), true);
  await ui.close();
});

test('hiding the controls clears the preview but keeps a same-post frame cached', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen(), timeline = ui.document.getElementById('timeline'), preview = ui.document.getElementById('timeline-preview');
  ui.position(20); timeline.focus(); t.mock.timers.tick(250); await tick();
  const image = preview.querySelector('img').src;
  t.mock.timers.tick(4750); await tick();
  assert.equal(preview.hidden, true);
  const requests = ui.requests.filter(path => path.startsWith('/api/preview/')).length;
  await ui.key(38);
  assert.equal(preview.hidden, false);
  assert.equal(preview.querySelector('img').src, image);
  assert.equal(ui.requests.filter(path => path.startsWith('/api/preview/')).length, requests);
  await ui.close();
});

test('playback errors wake the controls and stay visible beyond the idle deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const browser of [false, true]) {
    await t.test(browser ? 'browser' : 'native', async () => {
      const ui = await screen({browser}), panel = ui.document.querySelector('.player-shade');
      t.mock.timers.tick(5000); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), true);
      ui.runtimeError(); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      t.mock.timers.tick(10000); await tick();
      assert.equal(panel.classList.contains('controls-hidden'), false);
      assert.notEqual(ui.document.getElementById('player-status').textContent, '');
      await ui.close();
    });
  }
});

test('language change keeps playback, frame cache and reader position without another API request', async () => {
  const ui = await screen({language: null});
  assert.equal(ui.document.getElementById('feed').textContent, 'Feed');
  ui.position(20); ui.document.getElementById('timeline').focus(); await tick();
  const frame = ui.document.getElementById('timeline-preview').querySelector('img').src;
  const requests = ui.requests.length, calls = ui.calls.length;
  ui.document.getElementById('language').dispatchEvent(new ui.window.Event('click'));
  assert.equal(ui.document.getElementById('feed').textContent, 'Лента');
  assert.equal(ui.document.getElementById('timeline-preview').querySelector('img').src, frame);
  assert.equal(ui.calls.length, calls); assert.equal(ui.requests.length, requests);
  assert.equal(ui.document.getElementById('timeline').value, '20');
  await ui.close();
  const back = new ui.window.Event('keydown'); back.keyCode = 27; ui.document.dispatchEvent(back); await tick();
  ui.document.getElementById('language').dispatchEvent(new ui.window.Event('click'));
  assert.equal(ui.document.getElementById('title').textContent, 'Feed');
  assert.equal(ui.document.querySelector('.card h2').textContent, 'Проверка публикации');
});

test('language refresh preserves the retry control in an error panel', async () => {
  const ui = await screen({feedOnly: true, offline: true, language: null});
  const retry = ui.document.querySelector('#content button');
  assert.ok(retry); assert.equal(retry.textContent, 'Retry');
  ui.document.getElementById('language').onclick();
  assert.equal(ui.document.querySelector('#content button') === retry, true);
  assert.equal(retry.textContent, 'Повторить');
  const before = ui.requests.length; retry.dispatchEvent(new ui.window.Event('click')); await tick();
  assert.equal(ui.requests.length, before + 1);
});
