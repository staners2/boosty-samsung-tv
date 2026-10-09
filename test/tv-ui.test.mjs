import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

const bundle = await build({entryPoints: ['web/tv/app.js'], bundle: true, format: 'iife', write: false, target: 'es2019'});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function screen({stallProgress = false, reading = false, browser = false, timecode = false, seekError = false, pages, feedOnly = false, stallFeed = false, stallInitialFeed = false, body, previewError = false, contentId = 'content-17', metadataDuration = 180, twoVideos = false, stallPreview = false, language = 'ru', storageBlocked = false, offline = false} = {}) {
  const {document, window} = parseHTML(await readFile('web/tv/index.html', 'utf8'));
  const calls = [];
  let listener, finishProgress, finishFeed, finishInitialFeed, focused, intersection, initialFeedCount = 0;
  const requests = [], previewRequests = [];
  Object.defineProperty(document, 'activeElement', {get: () => focused?.isConnected && !focused.disabled ? focused : document.body, configurable: true});
  window.HTMLElement.prototype.focus = function () {
    focused = this;
    this.dispatchEvent(new window.Event('focusin', {bubbles: true}));
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.getBoundingClientRect = () => ({left: 0, top: 0, width: 100, height: 40});
  window.HTMLElement.prototype.getClientRects = function () { return this.hidden ? [] : [this.getBoundingClientRect()]; };
  window.scrollX = 0; window.scrollY = 0;
  window.scrollTo = (x, y) => {window.scrollX = x; window.scrollY = y;};
  const video = {id: 'vid-1', contentId, title: 'Проверка просмотра', duration: metadataDuration, timeCode: 0, preview: null, sources: [
    {url: 'https://video.example/master.m3u8', quality: 'hls', label: 'Авто'},
    {url: 'https://video.example/a.mp4', quality: 'full_hd', label: '1080p'}]};
  const post = {id: 'post-1', blog: 'test-author', title: 'Проверка публикации', locked: false,
    preview: null, body: body ?? (timecode ? [{type: 'timecode', title: '1:30', seconds: 90, videoId: 'vid-1', description: 'Обсуждение результатов'}] : reading ? [{type: 'text', text: 'Текст поста <script>danger()</script>'},
      {type: 'image', url: 'https://images.example/photo.jpg', title: 'Иллюстрация'}] : []),
    videos: reading ? [] : twoVideos ? [video, {...video, id: 'vid-10', contentId: 'content-170', title: 'Другой ролик'}] : [video]};
  const htmlVideo = document.getElementById('browser-video');
  htmlVideo.pause = () => {}; htmlVideo.play = () => Promise.resolve();
  htmlVideo.canPlayType = () => '';
  Object.defineProperty(htmlVideo, 'duration', {value: 180});
  Object.defineProperty(htmlVideo, 'src', {get: () => htmlVideo.getAttribute('src'), set: value => htmlVideo.setAttribute('src', value)});
  htmlVideo.load = () => {if (htmlVideo.src) queueMicrotask(() => htmlVideo.dispatchEvent(new window.Event('loadedmetadata')));};
  const dialog = document.getElementById('choices');
  dialog.close = () => dialog.removeAttribute('open');
  dialog.showModal = () => dialog.setAttribute('open', '');
  const avplay = {
    open: () => calls.push(['open']), close: () => calls.push(['close']),
    play: () => calls.push(['play']), pause: () => calls.push(['pause']),
    setDisplayRect() {}, setDisplayMethod() {}, setStreamingProperty() {},
    setListener: value => {listener = value;}, prepareAsync: success => success(),
    seekTo: (ms, success, failure) => {calls.push(['seek', ms]); if (seekError) failure('NotSupportedError'); else success();}, getDuration: () => 180000,
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
    else if (path === '/api/progress') {
      if (stallProgress) return new Promise(resolve => {finishProgress = () => resolve(new Response('{"ok":true}'));});
      body = {ok: true};
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
  if (feedOnly) return {document, window, requests, intersect: () => intersection?.([{isIntersecting: true}]), finishFeed: () => finishFeed?.(), finishInitialFeed: () => finishInitialFeed?.()};
  document.querySelector('.card').dispatchEvent(new window.Event('click'));
  await tick();
  if (!reading && !timecode) {
    document.querySelector('.video-row').dispatchEvent(new window.Event('click'));
    await tick();
  }
  return {document, window, calls, requests, previewRequests, position: seconds => listener.oncurrentplaytime(seconds * 1000), finishProgress: () => finishProgress?.()};
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
  await ui.document.getElementById('close-player').onclick();
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
  ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
});

test('timeline chapters use measured playback duration when Boosty has no duration metadata', async () => {
  const ui = await screen({metadataDuration: 0, body: [{type: 'timecode', seconds: 10, videoId: 'vid-1', description: 'Обсуждение результатов'}]});
  const timeline = ui.document.getElementById('timeline');
  timeline.focus(); timeline.value = '20'; timeline.oninput();
  assert.equal(timeline.disabled, false);
  assert.equal(timeline.max, 180);
  assert.equal(ui.document.querySelector('#timeline-preview .preview-chapter')?.textContent, 'Обсуждение результатов');
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
});

test('unavailable previews do not prevent a browser timeline seek', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({browser: true, previewError: true});
  const timeline = ui.document.getElementById('timeline'); timeline.focus(); timeline.value = '40'; timeline.oninput();
  t.mock.timers.tick(250); await tick();
  assert.match(ui.document.getElementById('timeline-preview')?.textContent || '', /Кадр недоступен/);
  await timeline.onchange();
  assert.equal(ui.document.getElementById('browser-video').currentTime, 40);
  await ui.document.getElementById('close-player').onclick();
});

test('leaving a timeline cancels its frame and a missing content id remains nonfatal', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const ui = await screen({contentId: null});
  const timeline = ui.document.getElementById('timeline'), panel = ui.document.getElementById('timeline-preview');
  timeline.focus();
  assert.match(panel.textContent, /Кадр недоступен/);
  assert.equal(timeline.disabled, false);
  ui.document.getElementById('toggle').focus();
  assert.equal(panel.hidden, true);
  t.mock.timers.tick(250); await tick();
  assert.equal(ui.requests.some(path => path.startsWith('/api/preview/')), false);
  timeline.focus(); timeline.dispatchEvent(new ui.window.Event('blur'));
  assert.equal(panel.hidden, true);
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
});

test('native seek failures are shown in the visible player instead of behind it', async () => {
  const ui = await screen({seekError: true});
  for (const keyCode of [38, 39, 13]) {
    const event = new ui.window.Event('keydown'); event.keyCode = keyCode; ui.document.dispatchEvent(event);
  }
  await tick();
  assert.match(ui.document.getElementById('player-status').textContent, /перемот|качество/i);
  await ui.document.getElementById('close-player').onclick();
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
  await ui.document.getElementById('close-player').onclick();
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
  assert.equal(ui.document.getElementById('quality').textContent, 'Качество: 1080p');
  await ui.document.getElementById('close-player').onclick();
});

test('reopening a video from the same post resumes its successfully saved position', async () => {
  const ui = await screen();
  ui.position(120); await tick();
  await ui.document.getElementById('close-player').onclick();
  ui.document.querySelector('.video-row').dispatchEvent(new ui.window.Event('click'));
  await tick();
  assert.ok(ui.calls.some(([name, ms]) => name === 'seek' && ms === 120000));
  await ui.document.getElementById('close-player').onclick();
});

test('language change keeps playback, frame cache and reader position without another API request', async () => {
  const ui = await screen({language: null});
  assert.equal(ui.document.getElementById('feed').textContent, 'Feed');
  ui.position(20); ui.document.getElementById('timeline').focus(); await tick();
  const frame = ui.document.getElementById('timeline-preview').querySelector('img').src;
  const requests = ui.requests.length, calls = ui.calls.length;
  ui.document.getElementById('player-language').dispatchEvent(new ui.window.Event('click'));
  assert.equal(ui.document.getElementById('feed').textContent, 'Лента');
  assert.equal(ui.document.getElementById('timeline-preview').querySelector('img').src, frame);
  assert.equal(ui.calls.length, calls); assert.equal(ui.requests.length, requests);
  assert.equal(ui.document.getElementById('timeline').value, '20');
  await ui.document.getElementById('close-player').onclick();
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
