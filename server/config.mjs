export function publicOrigin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_URL must be an HTTPS origin without a path; HTTP is allowed only on loopback.');
  }
  return url.origin;
}

export function runtimeConfig(env = process.env) {
  const portText = env.PORT || '8787';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  if (env.NODE_ENV === 'production' && !env.VAULT_KEY_FILE) throw new Error('Production requires VAULT_KEY_FILE with the persistent encryption key.');
  if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) throw new Error('Production requires PUBLIC_URL with the reachable HTTPS origin.');
  const dataDir = resolve(env.DATA_DIR || 'data');
  return {
    publicUrl: publicOrigin(env.PUBLIC_URL || `http://localhost:${port}`), basePath: mountPath(env.BASE_PATH || ''),
    host: env.HOST || '127.0.0.1', port, dataDir,
    keyPath: resolve(env.VAULT_KEY_FILE || join(dataDir, 'vault.key')), staticDir: resolve(env.STATIC_DIR || 'dist'),
  };
}

export function mountPath(value = '') {
  if (!value || value === '/') return '';
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('BASE_PATH must be one safe URL path segment, without a trailing slash');
  return value;
}
import {resolve, join} from 'node:path';
