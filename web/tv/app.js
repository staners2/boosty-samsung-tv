import {createI18n} from '../i18n.js';
import {messages} from '../../shared/messages.js';
import { Api } from '../api.js';
import { Player } from './player.js';
import { directionalTarget } from './navigation.js';
import { FramePreview } from './preview.js';

const i18n = createI18n();
const ui = (key, params = {}) => ({key, params, toString: () => i18n.text(key, typeof params === 'function' ? params() : params)});
function write(node, value, attribute = '') {
  i18n.bind(node, value?.key || null, value?.params || {}, attribute);
  if (!value?.key) {if (attribute) node.setAttribute(attribute, String(value ?? '')); else node.textContent = String(value ?? '');}
}
const errorText = error => ui(messages.en[error.messageKey] ? error.messageKey : 'request_failed');
const api = new Api(globalThis.BOOSTY_TV_API || '');
const proofStorageKey = `boosty-tv-proof:${api.origin}`;
let proofPersistent = true;
try { api.proof = localStorage.getItem(proofStorageKey) || ''; } catch { proofPersistent = false; }
function rememberProof(value) {
  api.proof = value;
  try { if (value) localStorage.setItem(proofStorageKey, value); else localStorage.removeItem(proofStorageKey); }
  catch { proofPersistent = false; }
}
const $ = id => document.getElementById(id);
const content = $('content'), status = $('status'), choices = $('choices');
const playerPanel = document.querySelector('.player-shade');
let profile, pair, pollTimer, route, activePage, currentVideo, lastSaved = -1, progressBusy = 0, returnPosition, pageObserver;
let scrubPosition = null, seeking = false, playbackError = '', currentPost, previewMode;
let timelineVideo, timelinePost, timelineDuration, timelineSegments = [];
let playbackRequest, playbackStarted = false;
let controlsTimer;
const stack = [];
let titleText = ui('welcome'), statusText = '';
function title(value) {titleText = value; write($('title'), value);}
const time = seconds => { const n = Math.max(0, Math.floor(seconds || 0)); return n >= 3600 ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
const framePreview = new FramePreview({
  request: (target, signal) => api.get(`/api/preview/${encodeURIComponent(target.blog)}/${encodeURIComponent(target.postId)}/${encodeURIComponent(target.videoId)}?seconds=${encodeURIComponent(target.seconds)}`, {}, {signal}),
  onChange: state => {
    const chapter = content.querySelector('.chapter-preview'), timeline = $('timeline-preview');
    for (const panel of [chapter, timeline].filter(Boolean)) {
      const visible = state.status !== 'hidden' && (panel === timeline ? previewMode === 'timeline' : previewMode === 'chapter');
      panel.hidden = !visible;
      const photo = panel.querySelector('img'); photo.hidden = !visible || !state.image;
      if (photo.hidden) photo.removeAttribute('src'); else if (photo.src !== state.image) photo.src = state.image;
      if (visible) {
        const caption = panel.querySelector('figcaption');
        if (!caption.firstElementChild) caption.append(element('span'), element('strong', '', 'preview-chapter'));
        write(caption.firstElementChild, ui('frameCaption', () => ({time: time(state.target.seconds),
          status: state.status === 'cached' ? ' · ' + i18n.text('frameAt', {time: time(state.frameSeconds)})
            : state.status === 'loading' ? ' · ' + i18n.text('loadingFrame') : state.status === 'error' ? ' · ' + i18n.text('frameUnavailable') : ''})));
        caption.lastElementChild.hidden = !state.target.caption;
        write(caption.lastElementChild, state.target.caption);
      }
    }
    positionPreview();
  },
});
function clearPreview({keepCache = false} = {}) { framePreview.clear({keepCache}); previewMode = null; }
function positionPreview() {
  const panel = $('timeline-preview'); if (panel.hidden) return;
  const width = $('timeline').getBoundingClientRect().width, bubble = panel.getBoundingClientRect().width;
  const ratio = player.duration > 0 ? (scrubPosition ?? player.position) / player.duration : 0;
  panel.style.left = `${Math.max(0, Math.min(Math.max(0, width - bubble), ratio * width - bubble / 2))}px`;
}
function selectFrame(post, video, seconds, caption = '') {
  if (document.hidden) return;
  const target = {blog: post.blog, postId: post.id, videoId: video.contentId, seconds, caption};
  const end = Math.max(0, Math.ceil(video.duration)-1);
  const neighbors = [Math.min(end, seconds+10), Math.max(0, seconds-10)];
  const chapters = (post.body || []).filter(block => block.type === 'timecode' && block.videoId === video.id
    && Number.isFinite(block.seconds) && block.seconds >= 0 && block.seconds <= end && block.seconds !== seconds)
    .sort((a, b) => Math.abs(a.seconds-seconds)-Math.abs(b.seconds-seconds)).slice(0, 2).map(block => block.seconds);
  const nearby = previewMode === 'chapter' ? [...chapters, ...neighbors] : [...neighbors, ...chapters];
  framePreview.select(target, nearby.map(seconds => ({...target, seconds})));
}
function selectTimelineFrame() {
  if (!currentVideo || !currentPost || $('timeline').disabled || seeking) return;
  scrubPosition ??= player.position; previewMode = 'timeline';
  const seconds = Math.floor(scrubPosition);
  let chapter;
  for (const block of currentPost.body || []) {
    if (block.type === 'timecode' && block.videoId === currentVideo.id && Number.isFinite(block.seconds)
      && block.seconds >= 0 && block.seconds <= seconds && block.seconds < player.duration
      && (!chapter || block.seconds > chapter.seconds)) chapter = block;
  }
  selectFrame(currentPost, currentVideo, seconds, chapter?.description || '');
}
function element(tag, text, className) { const node = document.createElement(tag); if (text) write(node, text); if (className) node.className = className; return node; }
function message(text, error = false) { statusText = text; write(status, text); status.classList.toggle('error', error); }
function action(task) { return async () => { try { await task(); } catch (error) { if (error.status === 401) { await closePlayer(); await connect(); } else if (!$('playback').hidden) { playbackError = errorText(error); write($('player-status'), playbackError); showPlayerControls(); } else message(errorText(error), true); } }; }
function button(label, task, className) {
  const node = element('button', label, className);
  node.addEventListener('click', action(async () => { node.focus({preventScroll: true}); await task(); }));
  return node;
}
function image(url, className, fallback = '▶') { if (!url) return element('span', fallback, 'poster-empty'); const node = element('img', '', className); node.src = url; node.alt = ''; node.loading = 'lazy'; node.addEventListener('error', () => node.replaceWith(element('span', fallback, 'poster-empty')), {once: true}); return node; }
function focusFirst(root = content) { root.querySelector('button:not(:disabled), input:not(:disabled), .post-body')?.focus(); }
function capturePosition() { return {focus: document.activeElement, x: window.scrollX || 0, y: window.scrollY || 0}; }
function restorePosition(position) {
  if (position?.focus?.isConnected && !position.focus.disabled) position.focus.focus({preventScroll: true});
  else focusFirst();
  window.scrollTo(position?.x || 0, position?.y || 0);
}
function empty(text, task) { const node = element('div', '', 'empty'); node.append(element('p', text)); if (task) node.append(button(ui('retry'), task)); content.append(node); }
function publicationDate(post) {
  const date = new Date((post.publishedAt ?? post.createdAt) * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const node = element('time', ui('date', () => ({value: date.toLocaleString(i18n.locale, {day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'})})), 'publication-date');
  node.setAttribute('datetime', date.toISOString());
  return node;
}

async function boot() {
  message(ui('connecting'));
  try { profile = await api.get('/api/me'); await signedIn(); }
  catch (error) { if (error.status === 401) await connect(); else { content.replaceChildren(); empty(errorText(error), boot); message(ui('unavailable'), true); focusFirst(); } }
}
async function signedIn() {
  pair = null; clearTimeout(pollTimer);
  $('sidebar').hidden = false; write($('account-name'), proofPersistent ? profile.name : ui('sessionOnly', {name: profile.name}));
  stack.length = 0;
  await navigate({kind: 'feed'}, false);
}
async function connect() {
  clearPreview();
  pageObserver?.disconnect(); pageObserver = null;
  clearTimeout(pollTimer); pair = null; profile = null; route = null; activePage = null; stack.length = 0;
  $('sidebar').hidden = true; title(ui('welcome'));
  content.replaceChildren(); message(ui('qrPreparing'));
  try {
    const created = await api.post('/api/pairs', {name: 'Samsung Boosty TV'});
    pair = created;
    const layout = element('div', '', 'pair');
    const qr = element('img'); qr.src = pair.qrImage; write(qr, ui('qrAlt'), 'alt');
    const instructions = element('div'); instructions.append(element('h2', ui('yourCreators')));
    const steps = element('div', '', 'steps');
    [ui('qrStep1'), ui('qrStep2'), ui('qrStep3')].forEach(text => steps.append(element('p', text)));
    instructions.append(steps, element('p', ui('googleNotice')), button(ui('refreshQr'), connect));
    layout.append(qr, instructions); content.append(layout); message(ui('qrLifetime')); focusFirst();
    poll(created);
  } catch (error) { message(errorText(error), true); empty(ui('pairFailed'), connect); focusFirst(); }
}
async function poll(expected) {
  if (pair !== expected || document.hidden) return;
  try {
    const state = await api.get(`/api/pairs/${expected.id}`, {'X-Poll-Key': expected.pollKey});
    if (pair !== expected) return;
    if (state.state === 'confirm') {
      content.replaceChildren(); title(ui('confirmAccount'));
      const panel = element('div', '', 'empty');
      panel.append(element('h2', state.profile.name), element('p', ui('profileQuestion')),
        button(ui('confirmTv'), async () => {
          const result = await api.post(`/api/pairs/${expected.id}/finish`, {}, {'X-Poll-Key': expected.pollKey});
          profile = result.profile;
          rememberProof(result.tvProof);
          await api.get('/api/me');
          await signedIn();
        }), button(ui('otherAccount'), connect));
      content.append(panel); message(ui('phoneConfirmed')); focusFirst(); return;
    }
    message(ui('waitingPhone', {minutes: Math.ceil((state.expiresAt - Date.now()) / 60000)}));
    pollTimer = setTimeout(() => poll(expected), 2000);
  } catch (error) {
    if (pair !== expected) return;
    message(errorText(error), true);
    if (![404, 410].includes(error.status)) pollTimer = setTimeout(() => poll(expected), 5000);
  }
}

async function navigate(next, remember = true) {
  clearPreview();
  pageObserver?.disconnect();
  if (remember && route) stack.push({route, page: activePage, nodes: [...content.childNodes], position: capturePosition(),
    title: titleText, status: statusText, error: status.classList.contains('error')});
  route = next;
  const view = {}; activePage = view;
  content.replaceChildren(); message(ui('loading'));
  window.scrollTo(0, 0);
  title(next.kind === 'authors' ? ui('authors') : next.kind === 'blog' ? next.title : next.kind === 'post' ? next.title : ui('feed'));
  const grid = element('div', '', next.kind === 'post' ? 'post' : 'grid'); content.append(grid);
  const path = next.kind === 'authors' ? '/api/subscriptions' : next.kind === 'blog' ? `/api/blog/${encodeURIComponent(next.blog)}` : next.kind === 'post' ? `/api/post/${encodeURIComponent(next.blog)}/${encodeURIComponent(next.id)}` : '/api/feed';
  let count = 0, nextOffset = null, loading = false, pageFailed = false;
  const loadedOffsets = new Set(), postCards = new Map();
  view.resume = () => {
    pageObserver?.disconnect();
    const more = content.querySelector('.more');
    if (!more || activePage !== view) return;
    more.disabled = loading;
    if (['feed', 'blog'].includes(next.kind) && globalThis.IntersectionObserver) {
      pageObserver = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, {rootMargin: '0px 0px 300px 0px'});
      pageObserver.observe(more);
    }
  };
  async function loadMore(manual = false) {
    if (loading || nextOffset === null || activePage !== view || (pageFailed && !manual)) return;
    const trigger = document.activeElement;
    try { await page(nextOffset); }
    catch (error) {
      if (activePage !== view) return;
      if (error.status === 401) { await connect(); return; }
      pageFailed = true; message(errorText(error), true);
      const more = content.querySelector('.more');
      if (more) {
        more.disabled = false; write(more, ui('retryLoad'));
        if (trigger === more && document.activeElement === document.body) more.focus();
      }
    }
  }
  grid.addEventListener('focusin', event => {
    if (!['feed', 'blog'].includes(next.kind)) return;
    const cards = [...grid.querySelectorAll('.card')];
    if (cards.indexOf(event.target) >= Math.max(0, cards.length - 6)) loadMore();
  });
  async function page(offset = null) {
    loading = true; pageFailed = false;
    const previousFocus = document.activeElement;
    const more = content.querySelector('.more'); if (more) more.disabled = true;
    try {
      const result = await api.get(path + (offset !== null ? `?offset=${encodeURIComponent(offset)}` : ''));
      if (activePage !== view) return;
      const selected = document.activeElement;
      pageObserver?.disconnect();
      content.querySelector('.more')?.remove();
      if (next.kind === 'post') {
        const date = publicationDate(result); if (date) grid.append(date);
        const article = element('article', '', 'post-body'); article.tabIndex = 0;
        const reader = element('div', '', 'post-reader');
        const preview = element('figure', '', 'chapter-preview'); preview.hidden = true;
        const frame = element('img'); write(frame, ui('chapterAlt'), 'alt'); frame.hidden = true;
        preview.append(frame, element('figcaption')); reader.append(article, preview);
        write(article, ui('postText'), 'aria-label');
        let chapters;
        for (const block of result.body || []) {
          if (block.type !== 'timecode') chapters = null;
          if (block.type === 'text') {
            for (const paragraph of block.text.split(/\n\s*\n/u)) {
              if (paragraph.trim()) article.append(element('p', paragraph));
            }
          }
          else if (block.type === 'image') {
            const photo = image(block.url, 'post-image', ui('imageUnavailable')); photo.alt = block.title;
            article.append(photo);
          } else if (block.type === 'timecode') {
            const video = result.videos.find(item => item.id === block.videoId);
            if (!video) { article.append(element('span', block.title)); continue; }
            if (!chapters) {
              chapters = element('section', '', 'post-chapters'); write(chapters, ui('chapters'), 'aria-label'); article.append(chapters);
            }
            reader.classList.add('has-chapters');
            const chapter = button('', () => startVideo(video, block.seconds, result), 'post-timecode');
            chapter.addEventListener('focusin', () => {
              previewMode = 'chapter';
              selectFrame(result, video, block.seconds, block.description || '');
            });
            chapter.append(element('span', time(block.seconds), 'post-timecode-time'));
            if (block.description) chapter.append(element('span', block.description, 'post-timecode-description'));
            chapters.append(chapter);
          } else article.append(button(block.type === 'file' ? ui('fileTitle', {title: block.title}) : block.title, async () => {
            const qr = await api.post('/api/qr', {url: block.url});
            choose(ui('openPhone'), [image(qr.qrImage, 'link-qr'), element('p', block.title)]);
            $('close-choices').focus();
          }, 'post-link'));
        }
        if (result.locked) article.append(element('p', ui('lockedNotice'), 'locked-notice'));
        if (article.childNodes.length) grid.append(reader);
        const videoList = element('div', '', 'post-videos'); grid.append(videoList);
        result.videos.forEach(video => {
          const node = button('', () => startVideo(video, undefined, result), 'video-row');
          const copy = element('div'); copy.append(element('h2', video.title || result.title), element('p', video.timeCode ? ui('resumeAt', {duration: time(video.duration), position: time(video.timeCode)}) : time(video.duration)));
          node.append(image(video.preview), copy); videoList.append(node);
        }); count = 1;
        if (!article.childNodes.length && !result.videos.length) grid.append(element('p', ui('emptyPost')));
      } else {
        const addedCards = new Set();
        result.items.forEach(item => {
          const key = `${item.blog}:${item.id}`;
          if (next.kind !== 'authors' && postCards.has(key)) return;
          let node;
          const copy = element('span', '', 'card-copy');
          if (next.kind === 'authors') {
            node = button('', () => navigate({kind: 'blog', blog: item.blog, title: item.title}), 'card author-card');
            node.append(image(item.avatar)); copy.append(element('h2', item.title), element('p', item.name));
          } else {
            node = button('', () => navigate({kind: 'post', blog: item.blog, id: item.id, title: item.title}), 'card');
            node.disabled = !item.blog;
            const firstVideo = item.videos[0];
            node.append(image(item.preview || firstVideo?.preview, '', item.locked ? ui('subscription') : ui('publication')));
            copy.append(element('h2', item.title), element('p', ui('cardMeta', () => ({author: item.author || item.blog || i18n.text('creator'), detail: item.locked ? i18n.text('lockedPost') : firstVideo ? time(firstVideo.duration) : i18n.text('textImages')}))));
            const date = publicationDate(item); if (date) copy.append(date);
            if (item.summary) copy.append(element('p', item.summary, 'post-summary'));
            postCards.set(key, {node, publishedAt: item.publishedAt ?? item.createdAt ?? 0});
          }
          node.append(copy); grid.append(node); addedCards.add(node); count++;
        });
        if (next.kind !== 'authors') {
          const orderedCards = [...postCards.values()].sort((a, b) => b.publishedAt - a.publishedAt);
          orderedCards.forEach(({node}) => grid.append(node));
          if (selected && grid.contains(selected)) selected.focus();
          else if (previousFocus === more && (selected === more || selected === document.body)) {
            (orderedCards.find(({node}) => addedCards.has(node))?.node || grid.querySelector('.card:last-child'))?.focus();
          }
        }
        loadedOffsets.add(offset);
        nextOffset = result.nextOffset ?? null;
        if (loadedOffsets.has(nextOffset)) nextOffset = null;
        if (nextOffset !== null) {
          const more = button(ui('loadMore'), () => loadMore(true), 'more'); content.append(more);
          view.resume();
        }
      }
      message(next.kind === 'post' ? ui('readerHint') : count ? ui(next.kind === 'authors' ? 'creatorCount' : 'postCount', {count}) : ui('emptyPage'));
      if (!count && !content.querySelector('.more')) empty(next.kind === 'authors' ? ui('noSubscriptions') : ui('noPosts'));
    } finally {
      loading = false;
      if (activePage === view) {
        const more = content.querySelector('.more'); if (more) more.disabled = false;
      }
    }
  }
  try { await page(); if (activePage === view) focusFirst(); }
  catch (error) { if (activePage !== view) return; if (error.status === 401) { await connect(); return; } message(errorText(error), true); empty(ui('sectionFailed'), () => navigate(next, false)); focusFirst(); }
}

function choose(title, items) {
  clearPreview({keepCache: !$('playback').hidden});
  write($('choices-title'), title); $('choices-content').replaceChildren(...items);
  choices.showModal(); focusFirst($('choices-content'));
  showPlayerControls();
}
function showPlayerControls() {
  clearTimeout(controlsTimer); controlsTimer = null;
  if ($('playback').hidden) return;
  playerPanel.classList.remove('controls-hidden');
  playerPanel.setAttribute('aria-hidden', 'false'); playerPanel.removeAttribute('inert');
  $('timeline').tabIndex = $('quality').tabIndex = 0;
  if (!choices.open && !seeking && playbackStarted && ['playing', 'paused', 'ended'].includes(player.state)) {
    controlsTimer = setTimeout(hidePlayerControls, 5000);
  }
}
function hidePlayerControls() {
  if ($('playback').hidden || choices.open || seeking || !['playing', 'paused', 'ended'].includes(player.state)) return;
  cancelScrub(); $('playback').focus();
  clearTimeout(controlsTimer); controlsTimer = null;
  playerPanel.classList.add('controls-hidden');
  playerPanel.setAttribute('aria-hidden', 'true'); playerPanel.setAttribute('inert', '');
  $('timeline').tabIndex = $('quality').tabIndex = -1;
}
function setQuality(source) {
  const label = ui('qualityValue', () => ({value: source.quality === 'hls' ? i18n.text('auto') : source.label}));
  for (const attribute of ['aria-label', 'title']) write($('quality'), label, attribute);
}
const player = new Player({
  avplay: globalThis.webapis?.avplay, video: $('browser-video'), width: innerWidth, height: innerHeight,
  onProgress: seconds => {
    updateTimeline();
    if (Math.abs(seconds - lastSaved) >= 15) saveProgress();
  },
  onState: state => {
    if (['loading', 'closed'].includes(state)) { clearPreview({keepCache: true}); playbackError = ''; scrubPosition = null; }
    if (state === 'closed') playbackStarted = false;
    if (['playing', 'paused', 'ended'].includes(state)) playbackStarted = true;
    write($('player-status'), playbackError || ({loading: ui('openingVideo'), buffering: ui('buffering'), paused: ui('pause'), ended: ui('ended'), playing: '', closed: '', error: ui('playError')})[state] || '');
    $('quality').disabled = !['playing', 'paused', 'ended'].includes(state);
    $('timeline').disabled = !['playing', 'paused', 'ended'].includes(state) || !Number.isFinite(player.duration) || player.duration <= 0;
    updateTimeline();
    if (['paused', 'ended'].includes(state)) saveProgress(true);
  },
  onError: error => { playbackError = errorText(error); write($('player-status'), playbackError); showPlayerControls(); },
});
function updateTimeline() {
  const seconds = scrubPosition ?? player.position;
  const duration = Number.isFinite(player.duration) && player.duration > 0 && !['loading', 'closed'].includes(player.state) ? player.duration : 0;
  $('time').textContent = `${time(seconds)} / ${time(duration)}`;
  $('timeline').max = Math.floor(duration); $('timeline').value = seconds;
  write($('timeline'), ui('timeOf', {position: time(seconds), duration: time(duration)}), 'aria-valuetext');
  updateTimelineSegments(seconds, duration);
}
function updateTimelineSegments(seconds, duration) {
  const track = $('timeline-segments');
  if (timelineVideo !== currentVideo || timelinePost !== currentPost || timelineDuration !== duration) {
    const chapters = (currentPost?.body || []).filter(block => block.type === 'timecode' && block.videoId === currentVideo?.id
      && Number.isFinite(block.seconds) && block.seconds > 0 && block.seconds < duration).map(block => block.seconds);
    const boundaries = [0, ...[...new Set(chapters)].sort((a, b) => a - b), duration];
    timelineSegments = boundaries.slice(1).map((end, index) => {
      const start = boundaries[index], segment = element('span', '', 'timeline-segment');
      segment.style.left = `${duration > 0 ? start / duration * 100 : 0}%`;
      segment.style.width = `${duration > 0 ? (end - start) / duration * 100 : 100}%`;
      const background = element('span', '', 'timeline-segment-track'), fill = element('span', '', 'timeline-segment-fill');
      background.append(fill); segment.append(background);
      return {start, end, segment, fill};
    });
    track.replaceChildren(...timelineSegments.map(item => item.segment));
    timelineVideo = currentVideo; timelinePost = currentPost; timelineDuration = duration;
  }
  track.classList.toggle('disabled', $('timeline').disabled);
  for (const {start, end, fill} of timelineSegments) {
    fill.style.width = `${end > start && Number.isFinite(seconds) ? Math.max(0, Math.min(100, (seconds - start) / (end - start) * 100)) : 0}%`;
  }
}
function cancelScrub() { clearPreview({keepCache: true}); scrubPosition = null; updateTimeline(); }
async function commitScrub() {
  if (seeking || scrubPosition === null) return;
  clearPreview({keepCache: true});
  const seconds = scrubPosition; scrubPosition = null; seeking = true; playbackError = '';
  $('timeline').setAttribute('aria-busy', 'true'); write($('player-status'), ui('seek'));
  try { await player.seek(seconds, {absolute: true}); write($('player-status'), player.state === 'paused' ? ui('pause') : ''); }
  finally { seeking = false; $('timeline').removeAttribute('aria-busy'); updateTimeline(); showPlayerControls(); }
}
async function saveProgress(force = false) {
  if (!currentVideo || !playbackStarted || !Number.isFinite(player.position) || (!force && (progressBusy > 0 || Math.abs(player.position - lastSaved) < 15))) return;
  const videoId = currentVideo.id, seconds = Math.floor(player.position);
  const video = currentVideo, request = playbackRequest;
  progressBusy++; video.timeCode = seconds; lastSaved = seconds;
  try { await api.post('/api/progress', {videoId, seconds}); }
  catch { if (currentVideo === video && playbackRequest === request) { playbackError = ui('progressUnsaved'); write($('player-status'), playbackError); showPlayerControls(); } }
  finally { progressBusy--; }
}
async function startVideo(video, seconds, post) {
  playbackRequest?.abort();
  const request = playbackRequest = new AbortController();
  clearPreview({keepCache: true}); currentPost = post;
  returnPosition = capturePosition();
  currentVideo = video; playbackStarted = false; lastSaved = -1; scrubPosition = null; playbackError = '';
  $('playback').hidden = false; $('video-title').textContent = video.title;
  $('native-video').hidden = !globalThis.webapis?.avplay; $('browser-video').hidden = Boolean(globalThis.webapis?.avplay);
  $('timeline').disabled = $('quality').disabled = true;
  write($('player-status'), ui('openingVideo')); updateTimeline();
  showPlayerControls(); $('playback').focus();
  const hlsSupported = globalThis.webapis?.avplay || $('browser-video').canPlayType('application/vnd.apple.mpegurl');
  const source = (hlsSupported && video.sources.find(item => item.quality === 'hls'))
    || video.sources.find(item => item.quality === 'full_hd')
    || video.sources.find(item => !['hls', 'dash'].includes(item.quality)) || video.sources[0];
  setQuality(source);
  try {
    if (seconds === undefined) {
      const result = await api.get(`/api/progress/${encodeURIComponent(post.blog)}/${encodeURIComponent(post.id)}/${encodeURIComponent(video.id)}`, {}, {signal: request.signal});
      if (!Number.isFinite(result?.seconds) || result.seconds < 0) throw Object.assign(new Error(messages.en.invalid_response), {messageKey: 'invalid_response'});
      seconds = result.seconds;
    }
    if (request.signal.aborted || playbackRequest !== request || $('playback').hidden) return;
    lastSaved = Math.floor(seconds);
    await player.open(source, seconds);
    if (!request.signal.aborted && playbackRequest === request) { showPlayerControls(); $('playback').focus(); }
  }
  catch (error) {
    if (request.signal.aborted || playbackRequest !== request) return;
    if (error.status === 401) throw error;
    playbackError = errorText(error); write($('player-status'), playbackError); showPlayerControls();
  }
}
async function closePlayer() {
  if ($('playback').hidden) return;
  clearTimeout(controlsTimer); controlsTimer = null;
  clearPreview({keepCache: true}); currentPost = null;
  const saving = saveProgress(true);
  playbackRequest?.abort(); playbackRequest = null;
  const closing = player.close(); currentVideo = null;
  $('playback').hidden = true; choices.close(); restorePosition(returnPosition); returnPosition = null;
  await Promise.all([closing, saving]);
}
$('timeline').oninput = () => { showPlayerControls(); if (!seeking) { scrubPosition = Number($('timeline').value); selectTimelineFrame(); } updateTimeline(); };
$('timeline').onchange = action(commitScrub);
$('quality').onclick = () => choose(ui('videoQuality'), currentVideo.sources.map(source => button(source.quality === 'hls' ? ui('auto') : source.label, async () => {
  choices.close(); setQuality(source);
  const seconds = player.position, paused = player.state === 'paused';
  try { await player.open(source, seconds, paused); } catch (error) { playbackError = errorText(error); write($('player-status'), playbackError); }
  showPlayerControls(); if ($('quality').disabled) $('playback').focus(); else $('quality').focus();
})));
$('close-choices').onclick = () => { choices.close(); if (!$('playback').hidden) { showPlayerControls(); $('quality').focus(); } else focusFirst(); };
$('feed').onclick = action(() => { stack.length = 0; return navigate({kind: 'feed'}, false); });
$('authors').onclick = action(() => { stack.length = 0; return navigate({kind: 'authors'}, false); });
$('logout').onclick = () => choose(ui('logoutQuestion'), [button(ui('logout'), async () => { await api.post('/api/logout'); rememberProof(''); choices.close(); await connect(); })]);

async function back() {
  clearPreview({keepCache: choices.open || !$('playback').hidden});
  if (choices.open) { choices.close(); if (!$('playback').hidden) { showPlayerControls(); $('quality').focus(); } else focusFirst(); return; }
  if (!$('playback').hidden) { if (scrubPosition !== null) cancelScrub(); else await closePlayer(); return; }
  if (stack.length) {
    pageObserver?.disconnect();
    const previous = stack.pop(); route = previous.route; activePage = previous.page;
    content.replaceChildren(...previous.nodes); title(previous.title); i18n.refresh();
    message(previous.status, previous.error); activePage.resume(); restorePosition(previous.position); return;
  }
  choose(ui('closeQuestion'), [button(ui('closeApp'), () => { if (globalThis.tizen) tizen.application.getCurrentApplication().exit(); else { choices.close(); message(ui('browserClose')); } })]);
}
document.addEventListener('keydown', event => {
  const code = event.keyCode;
  if (!$('playback').hidden) showPlayerControls();
  if ([10009, 27].includes(code)) { event.preventDefault(); action(back)(); return; }
  if (!$('playback').hidden && !choices.open) {
    if ([415, 19, 10252, 32].includes(code)) { event.preventDefault(); action(() => player.toggle())(); return; }
    if ([412, 417].includes(code)) { event.preventDefault(); action(() => player.seek(code === 412 ? -10 : 10))(); return; }
    if (code === 413) { event.preventDefault(); action(closePlayer)(); return; }
    if (code === 38 && !$('timeline').disabled) { $('timeline').focus(); event.preventDefault(); return; }
    if ([37, 39].includes(code) && !$('timeline').disabled) {
      event.preventDefault(); $('timeline').focus();
      if (!seeking) { scrubPosition = player.clamp((scrubPosition ?? player.position) + (code === 37 ? -10 : 10)); updateTimeline(); selectTimelineFrame(); }
      return;
    }
    if (code === 40 && !$('quality').disabled) { event.preventDefault(); cancelScrub(); $('quality').focus(); return; }
    if (document.activeElement === $('timeline')) {
      if (code === 13) { event.preventDefault(); action(commitScrub)(); return; }
    }
    if (code === 13) { event.preventDefault(); if (document.activeElement === $('quality')) $('quality').onclick(); else action(() => player.toggle())(); return; }
  }
  const direction = {37: 'left', 38: 'up', 39: 'right', 40: 'down'}[code];
  if (!direction) return;
  event.preventDefault();
  const active = document.activeElement;
  if (active?.classList.contains('post-body') && [38, 40].includes(code)) {
    const max = active.scrollHeight - active.clientHeight;
    if ((code === 38 && active.scrollTop > 0) || (code === 40 && active.scrollTop < max)) {
      active.scrollTop = Math.max(0, Math.min(max, active.scrollTop + (code === 38 ? -1 : 1) * innerHeight * .35));
      return;
    }
  }
  const root = choices.open ? choices : !$('playback').hidden ? $('playback') : $('shell');
  const controls = [...root.querySelectorAll('button:not(:disabled), input:not(:disabled), .post-body')].filter(node => node.getClientRects().length);
  const index = directionalTarget(controls.map(node => node.getBoundingClientRect()), controls.indexOf(document.activeElement), direction);
  if (controls[index]) { controls[index].focus(); controls[index].scrollIntoView({block: 'nearest', inline: 'nearest'}); }
});
document.addEventListener('focusin', event => {
  if (!$('playback').hidden) showPlayerControls();
  if (event.target === $('timeline')) selectTimelineFrame();
  else if (!event.target.classList.contains('post-timecode')) {
    if (previewMode === 'timeline') cancelScrub(); else clearPreview({keepCache: true});
  }
});
$('timeline').addEventListener('blur', cancelScrub);
for (const type of ['pointermove', 'pointerdown', 'touchstart', 'wheel']) $('playback').addEventListener(type, showPlayerControls, {passive: true});
$('playback').addEventListener('click', event => {
  showPlayerControls();
  if (!playerPanel.contains(event.target)) action(() => player.toggle())();
});
window.addEventListener('resize', positionPreview);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearPreview(); clearTimeout(pollTimer); action(closePlayer)(); }
  else if (pair) poll(pair);
});
if (globalThis.tizen?.tvinputdevice) {
  try { tizen.tvinputdevice.registerKeyBatch(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaRewind', 'MediaFastForward']); }
  catch { message(ui('mediaKeysFailed'), true); }
}
for (const [selector, key, attribute] of [
  ['#feed', 'feed'], ['#authors', 'authors'], ['#logout', 'logout'], ['.eyebrow', 'cinema'],
  ['nav', 'mainMenu', 'aria-label'], ['#content', 'content', 'aria-label'], ['footer', 'navigation'],
  ['#playback', 'player', 'aria-label'], ['#timeline-preview img', 'frameAlt', 'alt'],
  ['#timeline', 'timeline', 'aria-label'], ['#quality', 'quality', 'aria-label'], ['#quality', 'quality', 'title'],
  ['#close-choices', 'back'],
]) i18n.bind(document.querySelector(selector), key, {}, attribute);
$('language').onclick = () => {
  i18n.setLanguage(i18n.language === 'en' ? 'ru' : 'en');
  $('language').textContent = i18n.language === 'en' ? 'EN / RU' : 'RU / EN';
};
i18n.refresh();

action(boot)();
