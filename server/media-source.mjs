import {createServer} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {resolve4 as dnsResolve4} from 'node:dns/promises';
import {BlockList, isIP} from 'node:net';
import {randomBytes} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {AppError} from './errors.mjs';

const sourceError = () => new AppError(502, 'preview_source', 'error_post_missing_23');
const denied = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) denied.addSubnet(network, prefix, 'ipv4');

export function isPublicIPv4(address) { return isIP(address) === 4 && !denied.check(address, 'ipv4'); }
export function validateMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('#')) throw sourceError();
  let target;
  try { target = new URL(value); } catch { throw sourceError(); }
  if (target.protocol !== 'https:' || target.username || target.password || target.port
    || !['.okcdn.ru', '.vkuser.net'].some(suffix => target.hostname.endsWith(suffix))) throw sourceError();
  return target;
}

function parseRange(value) {
  if (value === undefined) return null;
  const match = typeof value === 'string' && value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) throw sourceError();
  const start = match[1] ? Number(match[1]) : null, end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))
    || (start === null && end === 0) || (start !== null && end !== null && start > end)) throw sourceError();
  return {value, start, end};
}

function responseLength(response, range) {
  const length = response.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw sourceError();
  if (response.statusCode === 200) {
    if (range && range.start !== 0) throw sourceError();
    return length === undefined ? null : Number(length);
  }
  const match = response.headers['content-range']?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (response.statusCode !== 206 || !range || !match) throw sourceError();
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || end < start || end >= total
    || (length !== undefined && Number(length) !== end-start+1)) throw sourceError();
  const expectedStart = range.start ?? Math.max(0, total-range.end);
  const expectedEnd = range.start === null || range.end === null ? total-1 : Math.min(range.end, total-1);
  if (start !== expectedStart || end !== expectedEnd) throw sourceError();
  return end-start+1;
}

export async function openMediaSource({url, userAgent, signal}, {resolve4 = dnsResolve4, request = httpsRequest} = {}) {
  if (typeof userAgent !== 'string' || !userAgent || userAgent.length > 1024 || /[\r\n]/.test(userAgent)) throw sourceError();
  signal?.throwIfAborted();
  const controller = new AbortController();
  const pending = new Set(), streams = new Set();
  let bytes = 0, closing;
  async function pin(target, currentSignal) {
    currentSignal.throwIfAborted();
    let abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(currentSignal.reason);
      currentSignal.addEventListener('abort', abort, {once: true});
    });
    let addresses;
    try { addresses = await Promise.race([resolve4(target.hostname), cancellation]); }
    finally { currentSignal.removeEventListener('abort', abort); }
    currentSignal.throwIfAborted();
    if (!addresses.length || !addresses.every(isPublicIPv4)) throw sourceError();
    return {target, address: addresses[0]};
  }
  const initial = await pin(validateMediaUrl(url), signal ?? controller.signal);
  const path = '/'+randomBytes(24).toString('base64url');
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url !== path) {outgoing.writeHead(404); outgoing.end(); return;}
    if (!['GET', 'HEAD'].includes(incoming.method)) {outgoing.writeHead(405); outgoing.end(); return;}
    let range;
    try {range = parseRange(incoming.headers.range);}
    catch {outgoing.writeHead(416); outgoing.end(); return;}
    const disconnected = new AbortController();
    const requestSignal = AbortSignal.any([controller.signal, disconnected.signal]);
    const disconnect = () => disconnected.abort(); outgoing.once('close', disconnect);
    let current = initial, activeTransfer, activeStream;
    try {
      for (let hop = 0; ; hop++) {
        requestSignal.throwIfAborted();
        const upstream = await new Promise((resolve, reject) => {
          const transfer = request(current.target, {
            method: incoming.method, agent: false, servername: current.target.hostname,
            family: 4, autoSelectFamily: false,
            lookup: (_host, options, done) => options.all
              ? done(null, [{address: current.address, family: 4}]) : done(null, current.address, 4),
            headers: {'user-agent': userAgent, accept: 'video/mp4', 'accept-encoding': 'identity', ...(range ? {range: range.value} : {})},
            signal: requestSignal,
          }, response => {activeStream = response; streams.add(response); response.once('close', () => streams.delete(response)); resolve(response);});
          activeTransfer = transfer;
          pending.add(transfer); transfer.once('close', () => pending.delete(transfer));
          transfer.once('error', reject); transfer.end();
        });
        if ([301, 302, 303, 307, 308].includes(upstream.statusCode)) {
          const location = upstream.headers.location; upstream.destroy();
          if (hop >= 5 || typeof location !== 'string') throw sourceError();
          current = await pin(validateMediaUrl(new URL(location, current.target).href), requestSignal); continue;
        }
        if (upstream.statusCode === 416) {
          const contentRange = upstream.headers['content-range']; upstream.destroy();
          if (!/^bytes \*\/\d+$/.test(contentRange)) throw sourceError();
          outgoing.writeHead(416, {'content-range': contentRange, 'content-length': '0'}); outgoing.end(); return;
        }
        const expectedLength = responseLength(upstream, range);
        const headers = {'content-type': 'video/mp4', 'accept-ranges': 'bytes'};
        if (expectedLength !== null) headers['content-length'] = String(expectedLength);
        if (upstream.statusCode === 206) headers['content-range'] = upstream.headers['content-range'];
        outgoing.writeHead(upstream.statusCode, headers);
        if (incoming.method === 'HEAD') {upstream.destroy(); outgoing.end(); return;}
        let sent = 0;
        const bounded = new Transform({
          transform(chunk, _encoding, done) {
            bytes += chunk.length; sent += chunk.length;
            done(bytes > 16*1024*1024 || (expectedLength !== null && sent > expectedLength) ? sourceError() : null, chunk);
          },
          flush(done) {done(expectedLength !== null && sent !== expectedLength ? sourceError() : null);},
        });
        await pipeline(upstream, bounded, outgoing, {signal: requestSignal}); return;
      }
    } catch {
      activeTransfer?.destroy(); activeStream?.destroy();
      if (!outgoing.headersSent && !outgoing.destroyed) {outgoing.writeHead(502); outgoing.end();}
      else outgoing.destroy();
      if (bytes > 16*1024*1024) void close();
    } finally {outgoing.removeListener('close', disconnect);}
  });
  function close() {
    if (closing) return closing;
    controller.abort(); signal?.removeEventListener('abort', abort);
    for (const transfer of pending) transfer.destroy();
    for (const stream of streams) stream.destroy();
    server.closeAllConnections();
    closing = new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
    return closing;
  }
  const abort = () => {void close();};
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  if (signal?.aborted) {await close(); signal.throwIfAborted();}
  signal?.addEventListener('abort', abort, {once: true});
  return {url: `http://127.0.0.1:${server.address().port}${path}`, close};
}
