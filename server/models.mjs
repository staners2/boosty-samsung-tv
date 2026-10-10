const qualities = {
  hls: ['Auto', 0], dash: ['Auto DASH', 1],
  ultra_hd: ['2160p', 2], quad_hd: ['1440p', 3], full_hd: ['1080p', 4],
  high: ['720p', 5], medium: ['480p', 6], low: ['360p', 7], lowest: ['240p', 8], tiny: ['144p', 9],
  mp4: ['MP4', 10],
};
const aliases = { ultra: 'ultra_hd', ultrahd: 'ultra_hd', quad: 'quad_hd', quadhd: 'quad_hd',
  full: 'full_hd', fullhd: 'full_hd', hd: 'high', sd: 'medium', mobile: 'tiny',
  ondemand_hls: 'hls', ondemand_dash: 'dash' };

export function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function normalizeVideo(raw) {
  if (raw?.type !== 'ok_video' || !raw.vid || !Array.isArray(raw.playerUrls)) return null;
  const sources = new Map();
  for (const entry of raw.playerUrls) {
    const original = String(entry?.type ?? '').toLowerCase();
    const quality = aliases[original] ?? original;
    const url = httpsUrl(entry?.url);
    if (!url || !Object.hasOwn(qualities, quality) || sources.has(quality)) continue;
    sources.set(quality, { quality, label: qualities[quality][0], url });
  }
  if (!sources.size) return null;
  const timeCode = typeof raw.timeCode === 'number' || (typeof raw.timeCode === 'string' && raw.timeCode.trim()) ? Number(raw.timeCode) : NaN;
  return {
    id: String(raw.vid), title: String(raw.title ?? ''),
    contentId: raw.id == null || String(raw.id) === '' ? null : String(raw.id),
    preview: httpsUrl(raw.preview) ?? httpsUrl(raw.defaultPreview),
    duration: Math.max(0, Number(raw.duration) || 0),
    timeCode: Number.isFinite(timeCode) && timeCode >= 0 ? timeCode : null,
    sources: [...sources.values()].sort((a, b) => qualities[a.quality][1] - qualities[b.quality][1]),
  };
}

export function selectPreviewSource(video) {
  return video.sources.filter(source => !['hls', 'dash', 'mp4'].includes(source.quality)).at(-1)
    ?? video.sources.find(source => source.quality === 'mp4') ?? null;
}

function contentText(value) {
  try {
    const content = JSON.parse(value);
    if (Array.isArray(content) && content.length === 3 && typeof content[0] === 'string' && typeof content[1] === 'string'
      && /^(unstyled|header-(one|two|three|four|five|six)|unordered-list-item|ordered-list-item|blockquote|code-block|atomic)$/.test(content[1])
      && content[2] !== null && typeof content[2] === 'object') return content[0];
  } catch { return value; }
  return value;
}

function timestampSeconds(value) {
  const seconds = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
    ? Number(value) : NaN;
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8640000000000 ? seconds : null;
}

function normalizeBody(entries, postPath, videosByContentId) {
  const body = [];
  let text = '', chapter = null;
  function flushText() {
    if (chapter) {
      const [caption, ...remaining] = text.split(/\r?\n/);
      const description = caption.trim().replace(/^[-–—:]\s*/, '');
      if (description) chapter.description = description;
      text = remaining.join('\n'); chapter = null;
    }
    if (text.trim()) body.push({type: 'text', text: text.trim()});
    text = '';
  }
  for (const entry of entries) {
    if (entry?.type === 'text' && typeof entry.content === 'string') {
      text += contentText(entry.content) + (entry.modificator === 'BLOCK_END' ? '\n\n' : '');
      if (chapter && entry.modificator === 'BLOCK_END') flushText();
      continue;
    }
    if (!['image', 'link', 'file'].includes(entry?.type)) continue;
    const url = httpsUrl(entry.url);
    if (!url) continue;
    flushText();
    let title = String(entry.title || '');
    if (entry.type === 'link' && typeof entry.content === 'string') {
      title = contentText(entry.content);
    }
    const parsedUrl = new URL(url);
    title ||= parsedUrl.hostname;
    if (entry.type === 'link' && parsedUrl.host === 'boosty.to' && parsedUrl.pathname === postPath) {
      const time = parsedUrl.searchParams.get('t');
      const seconds = Number(time);
      const video = videosByContentId.get(parsedUrl.searchParams.get('tmid'));
      const maxSeconds = video?.duration > 0 && Number.isFinite(video.duration) ? video.duration : 86400;
      if (time !== null && /^\d+$/.test(time) && Number.isSafeInteger(seconds) && seconds <= maxSeconds
        && parsedUrl.searchParams.getAll('t').length === 1 && parsedUrl.searchParams.getAll('tmid').length === 1
        && video) {
        chapter = {type: 'timecode', title, seconds, videoId: video.id};
        body.push(chapter);
        if (entry.modificator === 'BLOCK_END') chapter = null;
        continue;
      }
    }
    body.push({type: entry.type, url, title});
  }
  flushText();
  return body;
}

export function normalizePosts(raw) {
  const posts = Array.isArray(raw?.data) ? raw.data : raw?.data?.posts;
  if (!Array.isArray(posts)) throw new AppError(502, 'upstream_response', 'error_upstream_response_50');
  const items = [];
  for (const post of posts) {
    if (!post?.id) continue;
    const locked = post.hasAccess !== true;
    const entries = locked ? post.teaser : post.data;
    const videos = [];
    const videosByContentId = new Map();
    if (!locked && Array.isArray(post.data)) {
      for (const entry of post.data) {
        const video = normalizeVideo(entry);
        if (!video) continue;
        videos.push(video);
        if (entry.id !== undefined && entry.id !== null && String(entry.id)) videosByContentId.set(String(entry.id), video);
      }
    }
    const blog = String(post.user?.blogUrl ?? post.blog?.blogUrl ?? '');
    const body = normalizeBody(Array.isArray(entries) ? entries : [], blog ? `/${blog}/posts/${post.id}` : null, videosByContentId);
    const createdAt = timestampSeconds(post.createdAt) ?? 0;
    items.push({
      id: String(post.id), title: String(post.title ?? 'Video'),
      blog,
      author: String(post.user?.name ?? post.blog?.owner?.name ?? ''),
      avatar: httpsUrl(post.user?.avatarUrl ?? post.blog?.owner?.avatarUrl),
      createdAt, publishedAt: timestampSeconds(post.publishTime) ?? createdAt, locked, body, videos,
      preview: videos[0]?.preview ?? body.find(block => block.type === 'image')?.url ?? null,
      summary: body.filter(block => block.type === 'text').map(block => block.text).join(' ').slice(0, 180),
    });
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  return { items, nextOffset: raw.extra?.isLast !== true && typeof raw.extra?.offset === 'string'
    && raw.extra.offset ? raw.extra.offset : null };
}

export function normalizeSubscriptions(raw, offset = 0, limit = 100) {
  if (!Array.isArray(raw?.data)) throw new AppError(502, 'upstream_response', 'error_upstream_response_51');
  const items = raw.data.filter(entry => entry?.blog?.blogUrl).map(({ blog }) => ({
    blog: String(blog.blogUrl), title: String(blog.title ?? blog.owner?.name ?? blog.blogUrl),
    name: String(blog.owner?.name ?? ''), avatar: httpsUrl(blog.owner?.avatarUrl),
  }));
  const next = offset + raw.data.length;
  const hasMore = raw.data.length > 0 && (Number.isFinite(raw.total) ? next < raw.total : raw.data.length >= limit);
  return { items, nextOffset: hasMore ? next : null };
}
import { AppError } from './errors.mjs';
