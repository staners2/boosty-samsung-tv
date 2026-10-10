import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { AppError } from './errors.mjs';
import { BoostyClient, defaultUserAgent } from './boosty.mjs';
import {PreviewService} from './preview.mjs';
import { Pairing, normalizePhone } from './pairing.mjs';
import { httpsUrl, normalizePosts, normalizeSubscriptions } from './models.mjs';
import { publicOrigin, mountPath } from './config.mjs';

const sessionDuration = 180 * 86400000;
const progressDuration = 24 * 60 * 60 * 1000;
const progressLimit = 1000;
const cookieName = 'boostytv';
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[\w.-]{1,160}$/.test(value);

async function jsonBody(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'json_required', 'error_json_required_1');
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 16384) throw new AppError(413, 'body_too_large', 'error_body_too_large_2');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new AppError(400, 'invalid_json', 'error_invalid_json_3'); }
}

function profileView(raw) {
  if (!raw || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) throw new AppError(502, 'upstream_response', 'error_upstream_response_4');
  return { id: String(raw.id), name: String(raw.name || 'Boosty profile'), avatar: httpsUrl(raw.avatarUrl) };
}

export async function createApp({ publicUrl, basePath = '', vault, boosty, staticDir, now = Date.now, preview = new PreviewService() } = {}) {
  const origin = publicOrigin(publicUrl);
  const prefix = mountPath(basePath);
  const secure = origin.startsWith('https:');
  const data = await vault.load();
  const pairing = new Pairing({ now });
  const api = boosty ?? new BoostyClient({ now, onUpdate: () => vault.save(data) });
  const rate = new Map();
  const progressUpdates = new Map();
  const persist = () => vault.save(data);
  if (!data.progress || typeof data.progress !== 'object' || Array.isArray(data.progress)) data.progress = {};
  const progressKey = (session, videoId) => `${digest(session.profile.id)}:${videoId}`;
  function validProgress(entry) {
    return entry && Number.isSafeInteger(entry.seconds) && entry.seconds >= 0 && entry.seconds <= 604800
      && Number.isFinite(entry.savedAt) && entry.savedAt <= now() && now() - entry.savedAt < progressDuration;
  }
  function cachedProgress(session, videoId) {
    const entry = data.progress[progressKey(session, videoId)];
    return validProgress(entry) ? entry.seconds : undefined;
  }
  function rememberProgress(session, videoId, seconds, readStarted = Infinity) {
    if (!identifier(videoId) || !Number.isFinite(seconds) || seconds < 0 || seconds > 604800) return false;
    const key = progressKey(session, videoId), previous = data.progress[key];
    if (readStarted !== Infinity && progressUpdates.has(key)) return false;
    if (validProgress(previous) && previous.savedAt >= readStarted) return false;
    const entry = {seconds: Math.floor(seconds), savedAt: now()};
    if (previous?.seconds === entry.seconds && previous.savedAt === entry.savedAt) return false;
    data.progress[key] = entry;
    return true;
  }
  function pruneProgress() {
    for (const [key, entry] of Object.entries(data.progress)) if (!validProgress(entry)) delete data.progress[key];
    const entries = Object.entries(data.progress).sort((a, b) => b[1].savedAt - a[1].savedAt);
    for (const [key] of entries.slice(progressLimit)) delete data.progress[key];
  }
  async function applyProgress(posts, session, readStarted) {
    let changed = false;
    for (const post of posts) for (const video of post.videos) {
      if (video.timeCode !== null) changed = rememberProgress(session, video.id, video.timeCode, readStarted) || changed;
      else {
        const seconds = cachedProgress(session, video.id) ?? 0;
        video.timeCode = video.duration > 0 ? Math.min(seconds, video.duration) : seconds;
      }
    }
    if (changed) {pruneProgress(); await persist();}
  }
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self' ${origin}; media-src https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  };
  const cookie = (value, expired = false) => `${cookieName}=${value}; Path=${prefix}/; HttpOnly; Max-Age=${expired ? 0 : sessionDuration / 1000}; ${secure ? 'Secure; SameSite=None' : 'SameSite=Lax'}`;

  const server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    const requestOrigin = request.headers.origin;
    // Packaged Samsung TV apps omit Origin; browser requests still need an allowed origin.
    const allowedOrigin = requestOrigin === undefined || requestOrigin === origin || requestOrigin === 'null';
    if (allowedOrigin && requestOrigin !== undefined) {
      response.setHeader('access-control-allow-origin', requestOrigin);
      response.setHeader('access-control-allow-credentials', 'true');
      response.setHeader('vary', 'Origin');
    }
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, origin);
      if (prefix && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) throw new AppError(404, 'not_found', 'error_not_found_5');
      const path = url.pathname.slice(prefix.length) || '/';
      if (request.method === 'OPTIONS') {
        if (!allowedOrigin) throw new AppError(403, 'origin_rejected', 'error_origin_rejected_6');
        response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'Content-Type, X-TV-Request, X-Poll-Key, X-Link-Key, X-TV-Proof');
        response.writeHead(204); response.end(); return;
      }
      if (!['GET', 'POST', 'HEAD'].includes(request.method)) throw new AppError(405, 'method', 'error_method_7');
      if (path === '/health' && request.method === 'GET') { send(200, { status: 'ok' }); return; }
      if (!path.startsWith('/api/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new AppError(405, 'method', 'error_method_7');
        if (path === '/') { response.writeHead(302, { location: `${prefix}/tv/` }); response.end(); return; }
        if (path === '/tv/config.js' || path === '/link/config.js') {
          response.writeHead(200, {'content-type': 'text/javascript; charset=utf-8'});
          response.end(request.method === 'HEAD' ? undefined : `globalThis.BOOSTY_TV_API = ${JSON.stringify(origin + prefix)};\n`); return;
        }
        const files = {
          '/tv/': ['tv/index.html', 'text/html'], '/tv/index.html': ['tv/index.html', 'text/html'],
          '/tv/app.js': ['tv/app.js', 'text/javascript'], '/tv/config.js': ['tv/config.js', 'text/javascript'],
          '/tv/style.css': ['tv/style.css', 'text/css'], '/tv/icon.svg': ['tv/icon.svg', 'image/svg+xml'],
          '/link/app.js': ['link/app.js', 'text/javascript'], '/link/style.css': ['link/style.css', 'text/css'],
          '/link/config.js': ['tv/config.js', 'text/javascript'],
        };
        const entry = /^\/link\/[\w-]{24}$/.test(path) ? ['link/index.html', 'text/html'] : files[path];
        if (!entry) throw new AppError(404, 'not_found', 'error_not_found_5');
        let content;
        try { content = await readFile(join(staticDir, entry[0])); }
        catch (error) {
          if (error.code === 'ENOENT') throw new AppError(503, 'not_built', 'error_not_built_8');
          throw error;
        }
        if (entry[1] === 'text/html') content = content.toString('utf8').replaceAll('{{BASE_PATH}}', prefix);
        response.writeHead(200, { 'content-type': `${entry[1]}; charset=utf-8` });
        response.end(request.method === 'HEAD' ? undefined : content); return;
      }
      if (requestOrigin && !allowedOrigin) throw new AppError(403, 'origin_rejected', 'error_origin_rejected_6');
      if (request.method === 'POST' && (!allowedOrigin || request.headers['x-tv-request'] !== '1')) {
        throw new AppError(403, 'origin_rejected', 'error_origin_rejected_9');
      }
      const ip = request.socket.remoteAddress || 'unknown';
      const minute = Math.floor(now() / 60000);
      for (const [key, entry] of rate) if (entry.minute !== minute) rate.delete(key);
      if (!rate.has(ip) && rate.size >= 1000) throw new AppError(429, 'rate_limit', 'error_rate_limit_10');
      const counter = rate.get(ip) ?? { minute, count: 0, pairs: 0 };
      rate.set(ip, counter);
      if (++counter.count > 240) throw new AppError(429, 'rate_limit', 'error_rate_limit_11');

      if (path === '/api/pairs' && request.method === 'POST') {
        if (++counter.pairs > 6) throw new AppError(429, 'rate_limit', 'error_rate_limit_12');
        const body = await jsonBody(request);
        const pair = pairing.create(body.name);
        const linkUrl = `${origin}${prefix}/link/${pair.id}#${pair.linkKey}`;
        const qrImage = await QRCode.toDataURL(linkUrl, { errorCorrectionLevel: 'M', margin: 4, width: 480 });
        send(201, { id: pair.id, pollKey: pair.pollKey, linkUrl, qrImage, expiresAt: pair.expiresAt }); return;
      }
      const pairRoute = path.match(/^\/api\/pairs\/([\w-]{24})(?:\/(send|verify|finish))?$/);
      if (pairRoute) {
        const [, id, action] = pairRoute;
        if (!action && request.method === 'GET') {
          if (request.headers['x-poll-key']) send(200, pairing.poll(id, request.headers['x-poll-key']));
          else {
            const pair = pairing.phone(id, request.headers['x-link-key']);
            send(200, { state: pair.state, name: pair.name, expiresAt: pair.expiresAt, profile: pair.profile });
          }
          return;
        }
        if (request.method !== 'POST') throw new AppError(405, 'method', 'error_method_7');
        const body = await jsonBody(request);
        if (action === 'send') {
          const phone = normalizePhone(body.phone);
          const pair = pairing.beginSend(id, request.headers['x-link-key']);
          const resend = Boolean(pair.challenge);
          pair.sending = true;
          try {
            const challenge = await api.sendCode(pair.deviceId, phone, resend);
            pair.phone = phone; pair.challenge = challenge.code;
            pair.codeExpiresAt = now() + Math.min(600, challenge.expiresIn) * 1000;
            send(200, { ok: true });
          } finally { pair.sending = false; }
          return;
        }
        if (action === 'verify') {
          if (typeof body.code !== 'string' || !/^\d{4,8}$/.test(body.code)) throw new AppError(400, 'invalid_code', 'error_invalid_code_13');
          const pair = pairing.beginVerify(id, request.headers['x-link-key']);
          if (!pair.challenge || !pair.phone) throw new AppError(400, 'code_missing', 'error_code_missing_14');
          if (pair.codeExpiresAt <= now()) throw new AppError(410, 'code_expired', 'error_code_expired_15');
          pair.verifying = true;
          try {
            const session = await api.verifyCode(pair.deviceId, pair.phone, pair.challenge, body.code);
            session.deviceId = pair.deviceId;
            const profile = profileView(await api.request(session, 'v1/user/current'));
            pairing.authorize(id, request.headers['x-link-key'], session, profile);
            send(200, { profile });
          } finally { pair.verifying = false; }
          return;
        }
        if (action === 'finish') {
          const account = pairing.finish(id, request.headers['x-poll-key']);
          const token = randomBytes(32).toString('base64url');
          const tvProof = randomBytes(32).toString('base64url');
          data.sessions[digest(token)] = { ...account.session, profile: account.profile, proofHash: digest(tvProof), validUntil: now() + sessionDuration };
          await persist();
          response.setHeader('set-cookie', cookie(token));
          send(200, { profile: account.profile, tvProof }); return;
        }
        throw new AppError(404, 'not_found', 'error_not_found_16');
      }
      const token = request.headers.cookie?.split(';').map(value => value.trim())
        .find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      const sessionKey = typeof token === 'string' && /^[\w-]{43}$/.test(token) ? digest(token) : null;
      const session = sessionKey ? data.sessions[sessionKey] : null;
      if (!session || session.validUntil <= now()) {
        throw new AppError(401, 'reconnect', 'error_reconnect_17');
      }
      const proof = request.headers['x-tv-proof'];
      if (typeof proof !== 'string' || !/^[\w-]{43}$/.test(proof) || digest(proof) !== session.proofHash) {
        throw new AppError(401, 'reconnect', 'error_reconnect_18');
      }
      if (request.method === 'GET' && path === '/api/me') { send(200, session.profile); return; }
      if (request.method === 'POST' && path === '/api/qr') {
        const body = await jsonBody(request), url = httpsUrl(body.url);
        if (!url || url.length > 1800) throw new AppError(400, 'invalid_link', 'error_invalid_link_19');
        const qrImage = await QRCode.toDataURL(url, {errorCorrectionLevel: 'M', margin: 4, width: 480});
        send(200, {qrImage}); return;
      }
      if (request.method === 'POST' && path === '/api/logout') {
        await jsonBody(request); delete data.sessions[sessionKey]; preview.clearSession(sessionKey); await persist();
        response.setHeader('set-cookie', cookie('', true)); send(200, { ok: true }); return;
      }
      if (request.method === 'GET' && path === '/api/subscriptions') {
        const offset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new AppError(400, 'offset', 'error_offset_20');
        send(200, normalizeSubscriptions(await api.request(session,
          `v1/user/subscriptions?limit=100&with_follow=true&offset=${offset}`), offset, 100)); return;
      }
      const blogRoute = path.match(/^\/api\/blog\/([\w.-]{1,80})$/);
      if (request.method === 'GET' && (path === '/api/feed' || blogRoute)) {
        const offset = url.searchParams.get('offset');
        if (offset && (offset.length > 256 || /[\x00-\x1f]/.test(offset))) throw new AppError(400, 'offset', 'error_offset_21');
        const query = new URLSearchParams({ limit: '30', comments_limit: '0', reply_limit: '0' });
        if (offset) query.set('offset', offset);
        const resource = blogRoute ? `v1/blog/${blogRoute[1]}/post/` : 'v1/feed/post/';
        const readStarted = now();
        const result = normalizePosts(await api.request(session, `${resource}?${query}`, {userAgent: request.headers['user-agent']}));
        await applyProgress(result.items, session, readStarted);
        if (data.sessions[sessionKey] !== session || session.validUntil <= now()) throw new AppError(401, 'reconnect', 'error_reconnect_17');
        send(200, result); return;
      }
      const postRoute = path.match(/^\/api\/post\/([\w.-]{1,80})\/([\w.-]{1,160})$/);
      const progressRoute = path.match(/^\/api\/progress\/([\w.-]{1,80})\/([\w.-]{1,160})\/([\w.-]{1,160})$/);
      const previewRoute = path.match(/^\/api\/preview\/([\w.-]{1,80})\/([\w.-]{1,160})\/([\w.-]{1,160})$/);
      if (request.method === 'GET' && previewRoute) {
        const value = url.searchParams.get('seconds'), seconds = Number(value);
        if (value === null || !value.trim() || !Number.isFinite(seconds) || seconds < 0
          || url.searchParams.getAll('seconds').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'seconds')) {
          throw new AppError(400, 'preview_seconds', 'error_preview_seconds_22');
        }
        const [, blog, postId, videoId] = previewRoute;
        const controller = new AbortController(), userAgent = request.headers['user-agent'] || defaultUserAgent;
        const disconnected = () => {if (!response.writableFinished) controller.abort();};
        response.once('close', disconnected);
        try {
          const frame = await preview.get({sessionKey, blog, postId, videoId, seconds, userAgent, signal: controller.signal}, async signal => {
            const raw = await api.request(session, `v1/blog/${blog}/post/${postId}?comments_limit=0&reply_limit=0`, {userAgent, signal});
            const post = normalizePosts({data: [raw]}).items[0];
            if (!post) throw new AppError(404, 'post_missing', 'error_post_missing_23');
            if (post.locked) throw new AppError(403, 'preview_forbidden', 'error_post_missing_23');
            const video = post.videos.find(item => item.contentId === videoId);
            if (!video) throw new AppError(404, 'video_missing', 'error_post_missing_23');
            return video;
          });
          if (controller.signal.aborted || response.destroyed) return;
          if (data.sessions[sessionKey] !== session || session.validUntil <= now()) throw new AppError(401, 'reconnect', 'error_reconnect_17');
          send(200, frame); return;
        } finally {response.removeListener('close', disconnected);}
      }
      if (request.method === 'GET' && (postRoute || progressRoute)) {
        const target = postRoute || progressRoute, readStarted = now();
        let raw;
        try {
          raw = await api.request(session, `v1/blog/${target[1]}/post/${target[2]}?comments_limit=0&reply_limit=0`,
            {userAgent: request.headers['user-agent']});
        } catch (error) {
          if (data.sessions[sessionKey] !== session || session.validUntil <= now()) throw new AppError(401, 'reconnect', 'error_reconnect_17');
          const seconds = progressRoute ? cachedProgress(session, target[3]) : undefined;
          if (seconds === undefined || !(error instanceof AppError) || !(error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600))) throw error;
          send(200, {seconds}); return;
        }
        if (data.sessions[sessionKey] !== session || session.validUntil <= now()) throw new AppError(401, 'reconnect', 'error_reconnect_17');
        const post = normalizePosts({ data: [raw] }).items[0];
        if (!post) throw new AppError(404, 'post_missing', 'error_post_missing_24');
        if (progressRoute && post.locked) throw new AppError(403, 'progress_forbidden', 'error_post_missing_24');
        const video = progressRoute ? post.videos.find(video => video.id === target[3]) : null;
        if (progressRoute && !video) throw new AppError(404, 'video_missing', 'error_post_missing_24');
        await applyProgress([post], session, readStarted);
        if (data.sessions[sessionKey] !== session || session.validUntil <= now()) throw new AppError(401, 'reconnect', 'error_reconnect_17');
        if (progressRoute) {send(200, {seconds: video.timeCode}); return;}
        send(200, post); return;
      }
      if (request.method === 'POST' && path === '/api/progress') {
        const body = await jsonBody(request);
        if (!identifier(body.videoId) || !Number.isSafeInteger(body.seconds) || body.seconds < 0 || body.seconds > 604800) {
          throw new AppError(400, 'invalid_progress', 'error_invalid_progress_25');
        }
        rememberProgress(session, body.videoId, body.seconds); pruneProgress();
        const key = progressKey(session, body.videoId);
        const update = () => api.request(session, `v1/viewstat/video/${body.videoId}/timecode/`, {
          method: 'PUT', body: new URLSearchParams({ time_code: String(body.seconds) }),
        });
        const previous = progressUpdates.get(key);
        const pending = (async () => {
          await persist();
          return previous ? previous.then(update, update) : update();
        })();
        progressUpdates.set(key, pending);
        try {await pending;}
        finally {if (progressUpdates.get(key) === pending) progressUpdates.delete(key);}
        send(200, { ok: true }); return;
      }
      throw new AppError(404, 'not_found', 'error_not_found_16');
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof AppError) send(error.status, { code: error.code, message: error.message, messageKey: error.messageKey });
      else send(500, { code: 'server_error', message: 'Service error. Try again and check its status.', messageKey: 'server_error' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.closePreview = () => preview.close();
  server.once('close', () => {void preview.close();});
  return server;
}
