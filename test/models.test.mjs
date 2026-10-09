import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePosts, normalizeSubscriptions, selectPreviewSource } from '../server/models.mjs';

test('preview preserves content identity and selects the smallest progressive source', () => {
  for (const rawId of ['content-17', 17, null, undefined]) {
    const [video] = normalizePosts({data: [{id: 'post-1', hasAccess: true, data: [
      {type: 'ok_video', id: rawId, vid: 'playback-42', playerUrls: [
        {type: 'hls', url: 'https://vd580.okcdn.ru/master.m3u8'},
        {type: 'full_hd', url: 'https://vd580.okcdn.ru/hd.mp4'},
        {type: 'tiny', url: 'https://vd580.okcdn.ru/tiny.mp4'},
        {type: 'mp4', url: 'https://vd580.okcdn.ru/other.mp4'},
      ]}]}]}).items[0].videos;
    assert.equal(video.id, 'playback-42');
    assert.equal(video.contentId, rawId == null ? null : String(rawId));
    assert.equal(selectPreviewSource(video).quality, 'tiny');
    assert.equal(selectPreviewSource({sources: [video.sources[0]]}), null);
    assert.equal(selectPreviewSource({sources: [video.sources.at(-1)]}).quality, 'mp4');
    assert.equal(selectPreviewSource({sources: []}), null);
  }
});

test('a page without videos preserves its next cursor', () => {
  assert.deepEqual(normalizePosts({ data: [], extra: { offset: '7:4', isLast: false } }), {
    items: [], nextOffset: '7:4',
  });
});

test('authenticated feed reads posts from data.posts and retains its next cursor', () => {
  const result = normalizePosts({data: {blogs: [], counters: {}, posts: [{
    id: 'feed-post', title: 'Видео из ленты', hasAccess: true,
    user: {name: 'Автор ленты', blogUrl: 'feed-author'},
    data: [{type: 'ok_video', vid: 'feed-video',
      playerUrls: [{type: 'hls', url: 'https://cdn.example/feed.m3u8'}]}],
  }]}, extra: {isLast: false, offset: 'feed-next'}});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'feed-post');
  assert.equal(result.items[0].blog, 'feed-author');
  assert.equal(result.items[0].videos[0].sources[0].url, 'https://cdn.example/feed.m3u8');
  assert.equal(result.nextOffset, 'feed-next');
});

test('normalizes real ok_video sources, removes unsafe URLs and duplicate quality', () => {
  const result = normalizePosts({ data: [{
    id: 'post-1', title: 'Запись эфира', hasAccess: true, createdAt: 1700000000,
    user: { name: 'Автор', blogUrl: 'author', avatarUrl: 'https://images.example/a.jpg' },
    data: [{ type: 'ok_video', id: 'content-1', vid: 'video-1', title: 'Эфир',
      preview: 'https://images.example/preview.jpg', timeCode: 42, duration: 300,
      playerUrls: [{ type: 'high', url: 'https://cdn.example/720.mp4' },
        { type: 'hls', url: 'https://cdn.example/master.m3u8' },
        { type: 'high', url: 'https://cdn.example/duplicate.mp4' },
        { type: 'full_hd', url: 'javascript:alert(1)' },
        { type: 'rtmp', url: 'https://cdn.example/unsupported' }] }],
  }], extra: { isLast: true, offset: 'ignored' } });
  assert.equal(result.nextOffset, null);
  assert.equal(result.items[0].blog, 'author');
  assert.deepEqual(result.items[0].videos[0], {
    id: 'video-1', contentId: 'content-1', title: 'Эфир', preview: 'https://images.example/preview.jpg',
    duration: 300, timeCode: 42,
    sources: [{ quality: 'hls', label: 'Auto', url: 'https://cdn.example/master.m3u8' },
      { quality: 'high', label: '720p', url: 'https://cdn.example/720.mp4' }],
  });
});

test('locked posts keep only public teaser text and never expose full content or playable videos', () => {
  const post = { id: 'locked', title: 'Платный пост', hasAccess: false,
    data: [{ type: 'ok_video', vid: 'secret', playerUrls: [{type: 'high', url: 'https://cdn.example/full.mp4'}] }],
    teaser: [{type: 'text', content: 'Публичное описание', modificator: 'BLOCK_END'}],
  };
  const result = normalizePosts({data: [post]});
  assert.equal(result.items[0].locked, true);
  assert.deepEqual(result.items[0].videos, []);
  assert.deepEqual(result.items[0].body, [{type: 'text', text: 'Публичное описание'}]);
  assert.equal(JSON.stringify(result).includes('https://cdn.example/full.mp4'), false);
});

test('text and photo posts remain in the feed with paragraph boundaries and safe attachments', () => {
  const result = normalizePosts({data: [{id: 'reading-post', title: 'Новый пост', hasAccess: true,
    user: {blogUrl: 'reading-author'}, data: [
      {type: 'text', content: 'Первая ', modificator: ''},
      {type: 'text', content: 'строка', modificator: 'BLOCK_END'},
      {type: 'text', content: 'Второй абзац', modificator: 'BLOCK_END'},
      {type: 'image', url: 'https://images.example/photo.jpg', title: 'Фото'},
      {type: 'file', url: 'https://files.example/guide.pdf', title: 'Руководство'},
      {type: 'link', url: 'https://example.com/article', content: '["Статья","unstyled",{}]'},
      {type: 'image', url: 'javascript:alert(1)'},
    ]}]});
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].videos, []);
  assert.equal(result.items[0].preview, 'https://images.example/photo.jpg');
  assert.deepEqual(result.items[0].body, [
    {type: 'text', text: 'Первая строка\n\nВторой абзац'},
    {type: 'image', url: 'https://images.example/photo.jpg', title: 'Фото'},
    {type: 'file', url: 'https://files.example/guide.pdf', title: 'Руководство'},
    {type: 'link', url: 'https://example.com/article', title: 'Статья'},
  ]);
});

test('serialized text tuples expose only plaintext and preserve paragraph boundaries', () => {
  const {items: [post]} = normalizePosts({data: [{id: 'tuple-post', hasAccess: true, data: [
    {type: 'text', content: '["Вступление","unstyled",{}]', modificator: 'BLOCK_END'},
    {type: 'text', content: '["","unstyled",{}]', modificator: 'BLOCK_END'},
    {type: 'text', content: '["<b>Текст</b>","unstyled",{}]', modificator: 'BLOCK_END'},
    {type: 'link', url: 'https://example.com/start', content: '["0:00","unstyled",{}]'},
    {type: 'link', url: 'https://example.com/empty', content: '["","unstyled",{}]'},
  ]}]});
  assert.deepEqual(post.body, [
    {type: 'text', text: 'Вступление\n\n\n\n<b>Текст</b>'},
    {type: 'link', url: 'https://example.com/start', title: '0:00'},
    {type: 'link', url: 'https://example.com/empty', title: 'example.com'},
  ]);
  assert.equal(post.summary, 'Вступление\n\n\n\n<b>Текст</b>');
});

test('plain content and generic JSON remain literal instead of becoming text tuples', () => {
  const values = ['Обычный текст', '["JSON","custom-value",{}]', '["JSON","unstyled",null]',
    '["JSON",["unstyled"],{}]', '["JSON","unstyled"]', '{"text":"JSON"}', '["broken"'];
  for (const content of values) {
    const {items: [post]} = normalizePosts({data: [{id: 'plain-post', hasAccess: true, data: [
      {type: 'text', content, modificator: 'BLOCK_END'},
      {type: 'link', url: 'https://example.com/literal', content},
    ]}]});
    assert.deepEqual(post.body, [
      {type: 'text', text: content},
      {type: 'link', url: 'https://example.com/literal', title: content},
    ]);
  }
});

test('real array metadata tuples pair each timecode with its inline description and retain ordinary paragraphs', () => {
  const link = seconds => ({type: 'link', url: `https://boosty.to/author/posts/chapters?t=${seconds}&tmid=content-1`,
    content: JSON.stringify([seconds === 0 ? '0:00' : '2:30', 'unstyled', []])});
  const {items: [post]} = normalizePosts({data: [{id: 'chapters', hasAccess: true, user: {blogUrl: 'author'}, data: [
    {type: 'ok_video', id: 'content-1', vid: 'video-1', duration: 300,
      playerUrls: [{type: 'hls', url: 'https://cdn.example/video.m3u8'}]},
    {type: 'text', content: '["Таймкоды:","unstyled",[]]', modificator: 'BLOCK_END'},
    link(0), {type: 'text', content: '[" — Вступление","unstyled",[]]'},
    {type: 'text', content: '', modificator: 'BLOCK_END'},
    link(150), {type: 'text', content: '[" - Обсуждение результатов","unstyled",[]]'},
    {type: 'text', content: '', modificator: 'BLOCK_END'},
    {type: 'text', content: '["Обычный абзац после списка.","unstyled",[]]', modificator: 'BLOCK_END'},
  ]}]});
  assert.deepEqual(post.body, [
    {type: 'text', text: 'Таймкоды:'},
    {type: 'timecode', title: '0:00', seconds: 0, videoId: 'video-1', description: 'Вступление'},
    {type: 'timecode', title: '2:30', seconds: 150, videoId: 'video-1', description: 'Обсуждение результатов'},
    {type: 'text', text: 'Обычный абзац после списка.'},
  ]);
  assert.equal(JSON.stringify(post).includes('unstyled'), false);
});

test('a timecode without an inline caption never steals the following paragraph', () => {
  const {items: [post]} = normalizePosts({data: [{id: 'chapters', hasAccess: true, user: {blogUrl: 'author'}, data: [
    {type: 'ok_video', id: 'content-1', vid: 'video-1', duration: 300,
      playerUrls: [{type: 'hls', url: 'https://cdn.example/video.m3u8'}]},
    {type: 'link', url: 'https://boosty.to/author/posts/chapters?t=0&tmid=content-1', content: '0:00'},
    {type: 'text', content: '', modificator: 'BLOCK_END'},
    {type: 'text', content: 'Это отдельный абзац.', modificator: 'BLOCK_END'},
  ]}]});
  assert.deepEqual(post.body, [
    {type: 'timecode', title: '0:00', seconds: 0, videoId: 'video-1'},
    {type: 'text', text: 'Это отдельный абзац.'},
  ]);
});

test('a paragraph ending on the timecode link cannot capture the next paragraph as its caption', () => {
  const {items: [post]} = normalizePosts({data: [{id: 'chapters', hasAccess: true, user: {blogUrl: 'author'}, data: [
    {type: 'ok_video', id: 'content-1', vid: 'video-1', duration: 300,
      playerUrls: [{type: 'hls', url: 'https://cdn.example/video.m3u8'}]},
    {type: 'link', url: 'https://boosty.to/author/posts/chapters?t=0&tmid=content-1', content: '0:00', modificator: 'BLOCK_END'},
    {type: 'text', content: 'Отдельный абзац.', modificator: 'BLOCK_END'},
  ]}]});
  assert.deepEqual(post.body, [
    {type: 'timecode', title: '0:00', seconds: 0, videoId: 'video-1'},
    {type: 'text', text: 'Отдельный абзац.'},
  ]);
});

test('same-post timecodes target playable videos by content id and preserve zero seconds', () => {
  const {items: [post]} = normalizePosts({data: [{id: 'timed-post', hasAccess: true,
    user: {blogUrl: 'timed-author'}, data: [
      {type: 'ok_video', id: 'content-first', vid: 'video-first', duration: 300,
        playerUrls: [{type: 'hls', url: 'https://cdn.example/first.m3u8'}]},
      {type: 'ok_video', id: 'content-second', vid: 'video-second', duration: 600,
        playerUrls: [{type: 'high', url: 'https://cdn.example/second.mp4'}]},
      {type: 'text', content: '["Таймкоды","unstyled",{}]', modificator: 'BLOCK_END'},
      {type: 'link', url: 'https://boosty.to/timed-author/posts/timed-post?t=0&tmid=content-first',
        content: '["0:00","unstyled",{}]'},
      {type: 'link', url: 'https://boosty.to/timed-author/posts/timed-post?tmid=content-second&t=150',
        content: '2:30'},
    ]}]});
  assert.deepEqual(post.body, [
    {type: 'text', text: 'Таймкоды'},
    {type: 'timecode', title: '0:00', seconds: 0, videoId: 'video-first'},
    {type: 'timecode', title: '2:30', seconds: 150, videoId: 'video-second'},
  ]);
});

test('foreign or invalid timecode links remain ordinary safe links', () => {
  const urls = [
    'https://example.com/timed-author/posts/timed-post?t=150&tmid=content-first',
    'https://boosty.to.evil.example/timed-author/posts/timed-post?t=150&tmid=content-first',
    'https://boosty.to:8443/timed-author/posts/timed-post?t=150&tmid=content-first',
    'https://boosty.to/another-author/posts/timed-post?t=150&tmid=content-first',
    'https://boosty.to/timed-author/posts/another-post?t=150&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=150&tmid=video-first',
    'https://boosty.to/timed-author/posts/timed-post?t=150&tmid=unknown',
    'https://boosty.to/timed-author/posts/timed-post?t=150&tmid=unplayable',
    'https://boosty.to/timed-author/posts/timed-post?t=150',
    'https://boosty.to/timed-author/posts/timed-post?tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=-1&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=1.5&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=1e2&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=9007199254740992&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=301&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=150&t=0&tmid=content-first',
    'https://boosty.to/timed-author/posts/timed-post?t=150&tmid=content-first&tmid=unknown',
  ];
  const {items: [post]} = normalizePosts({data: [{id: 'timed-post', hasAccess: true,
    user: {blogUrl: 'timed-author'}, data: [
      {type: 'ok_video', id: 'content-first', vid: 'video-first', duration: 300,
        playerUrls: [{type: 'hls', url: 'https://cdn.example/first.m3u8'}]},
      {type: 'ok_video', id: 'unplayable', vid: 'bad-video', duration: 300,
        playerUrls: [{type: 'hls', url: 'javascript:alert(1)'}]},
      ...urls.map(url => ({type: 'link', url, content: '["2:30","unstyled",{}]'})),
    ]}]});
  assert.deepEqual(post.body, urls.map(url => ({type: 'link', url, title: '2:30'})));
});

test('timecodes on videos without a known duration are bounded', () => {
  const {items: [post]} = normalizePosts({data: [{id: 'timed-post', hasAccess: true,
    user: {blogUrl: 'timed-author'}, data: [
      {type: 'ok_video', id: 'content-first', vid: 'video-first',
        playerUrls: [{type: 'hls', url: 'https://cdn.example/first.m3u8'}]},
      {type: 'link', url: 'https://boosty.to/timed-author/posts/timed-post?t=10&tmid=content-first',
        content: '0:10'},
      {type: 'link', url: 'https://boosty.to/timed-author/posts/timed-post?t=86401&tmid=content-first',
        content: '24:00:01'},
    ]}]});
  assert.deepEqual(post.body, [
    {type: 'timecode', title: '0:10', seconds: 10, videoId: 'video-first'},
    {type: 'link', url: 'https://boosty.to/timed-author/posts/timed-post?t=86401&tmid=content-first', title: '24:00:01'},
  ]);
});

test('timecodes cannot verify a current post without an author path', () => {
  const url = 'https://boosty.to//posts/timed-post?t=0&tmid=content-first';
  const {items: [post]} = normalizePosts({data: [{id: 'timed-post', hasAccess: true, data: [
    {type: 'ok_video', id: 'content-first', vid: 'video-first', duration: 300,
      playerUrls: [{type: 'hls', url: 'https://cdn.example/first.m3u8'}]},
    {type: 'link', url, content: '0:00'},
  ]}]});
  assert.deepEqual(post.body, [{type: 'link', url, title: '0:00'}]);
});

test('locked timecode teasers never map or expose private playable content', () => {
  const url = 'https://boosty.to/timed-author/posts/timed-post?t=0&tmid=secret-content';
  const {items: [post]} = normalizePosts({data: [{id: 'timed-post', hasAccess: false,
    user: {blogUrl: 'timed-author'},
    data: [{type: 'text', content: '["Секретный текст","unstyled",{}]'},
      {type: 'ok_video', id: 'secret-content', vid: 'secret-video', duration: 300,
        playerUrls: [{type: 'hls', url: 'https://cdn.example/secret.m3u8'}]}],
    teaser: [{type: 'text', content: '["Доступный анонс","unstyled",{}]', modificator: 'BLOCK_END'},
      {type: 'link', url, content: '["0:00","unstyled",{}]'}],
  }]});
  assert.deepEqual(post.videos, []);
  assert.deepEqual(post.body, [{type: 'text', text: 'Доступный анонс'}, {type: 'link', url, title: '0:00'}]);
  assert.equal(JSON.stringify(post).includes('Секретный текст'), false);
  assert.equal(JSON.stringify(post).includes('https://cdn.example/secret.m3u8'), false);
});

test('publication time orders posts newest first while preserving creation time', () => {
  const {items} = normalizePosts({data: [
    {id: 'older-publication', hasAccess: true, createdAt: 1000, publishTime: 200},
    {id: 'created-fallback', hasAccess: true, createdAt: 250},
    {id: 'newer-publication', hasAccess: true, createdAt: 100, publishTime: '300'},
    {id: 'epoch-publication', hasAccess: true, createdAt: 2000, publishTime: 0},
  ]});
  assert.deepEqual(items.map(({id, createdAt, publishedAt}) => ({id, createdAt, publishedAt})), [
    {id: 'newer-publication', createdAt: 100, publishedAt: 300},
    {id: 'created-fallback', createdAt: 250, publishedAt: 250},
    {id: 'older-publication', createdAt: 1000, publishedAt: 200},
    {id: 'epoch-publication', createdAt: 2000, publishedAt: 0},
  ]);
});

test('malformed publication dates fall back to valid creation seconds', () => {
  const invalidTimes = [undefined, null, '', '2026-10-07T00:00:00Z', 'not-a-date', -1, 0.5,
    Infinity, NaN, true, [300], 8640000000001];
  for (const publishTime of invalidTimes) {
    const {items: [post]} = normalizePosts({data: [{id: 'fallback-date', hasAccess: true,
      createdAt: '250', publishTime}]});
    assert.equal(post.createdAt, 250);
    assert.equal(post.publishedAt, 250);
  }
});

test('malformed creation dates normalize to zero without breaking chronology', () => {
  const {items} = normalizePosts({data: [
    {id: 'infinite-date', hasAccess: true, createdAt: Infinity},
    {id: 'valid-date', hasAccess: true, createdAt: 100},
    {id: 'negative-date', hasAccess: true, createdAt: -1},
    {id: 'invalid-date', hasAccess: true, createdAt: 'not-a-date'},
  ]});
  assert.deepEqual(items.map(({id, createdAt, publishedAt}) => ({id, createdAt, publishedAt})), [
    {id: 'valid-date', createdAt: 100, publishedAt: 100},
    {id: 'infinite-date', createdAt: 0, publishedAt: 0},
    {id: 'negative-date', createdAt: 0, publishedAt: 0},
    {id: 'invalid-date', createdAt: 0, publishedAt: 0},
  ]);
});

test('normalizes subscription pagination without silently limiting authors to thirty', () => {
  const data = [{ blog: { blogUrl: 'first', title: 'Первый', owner: { name: 'Автор', avatarUrl: 'https://images.example/avatar.jpg' } } }];
  assert.deepEqual(normalizeSubscriptions({ data, total: 2 }, 0, 1), {
    items: [{ blog: 'first', title: 'Первый', name: 'Автор', avatar: 'https://images.example/avatar.jpg' }],
    nextOffset: 1,
  });
  assert.equal(normalizeSubscriptions({ data: [], total: 2 }, 1, 1).nextOffset, null);
});

test('malformed upstream collections fail clearly instead of pretending the feed is empty', () => {
  assert.throws(() => normalizePosts({ error: 'bad-response' }), {status: 502, code: 'upstream_response'});
  assert.throws(() => normalizeSubscriptions({ data: 'unexpected' }), {status: 502, code: 'upstream_response'});
});
