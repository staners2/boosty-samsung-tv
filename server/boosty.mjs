import { AppError } from './errors.mjs';
export const defaultUserAgent = 'BoostyTV/0.1.0 (personal Tizen client)';

export class BoostyClient {
  #fetch;
  #now;
  #onUpdate;
  #refreshes = new WeakMap();

  constructor({ fetch: request = globalThis.fetch, now = Date.now, onUpdate = async () => {} } = {}) {
    this.#fetch = request;
    this.#now = now;
    this.#onUpdate = onUpdate;
  }

  async #call(path, { session, method = 'GET', body, userAgent, signal } = {}) {
    signal?.throwIfAborted();
    if (typeof path !== 'string' || !/^[a-z][a-z0-9_/-]*(?:\?[^#]*)?$/i.test(path)
      || path.includes('..') || path.includes('://')) throw new Error('Invalid Boosty API path');
    if (userAgent !== undefined && (typeof userAgent !== 'string' || userAgent.length > 1024 || /[\r\n]/.test(userAgent))) {
      throw new AppError(400, 'invalid_user_agent', 'error_invalid_user_agent_26');
    }
    const headers = new Headers({ 'accept': 'application/json', 'x-app': 'web',
      'x-locale': 'ru_RU', 'origin': 'https://boosty.to', 'referer': 'https://boosty.to/',
      'user-agent': userAgent || defaultUserAgent });
    if (session?.deviceId) headers.set('x-from-id', session.deviceId);
    if (session?.accessToken) headers.set('authorization', `Bearer ${session.accessToken}`);
    if (body) headers.set('content-type', 'application/x-www-form-urlencoded');
    let response;
    try {
      response = await this.#fetch(`https://api.boosty.to/${path}`, {
        method, headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(502, 'boosty_unavailable', 'error_boosty_unavailable_27');
    }
    if (!response.ok) {
      if (response.status === 401) throw new AppError(401, 'reconnect', 'error_reconnect_28');
      if (response.status === 429) throw new AppError(429, 'boosty_rate_limit', 'error_boosty_rate_limit_29');
      if (response.status === 400) throw new AppError(400, 'boosty_rejected', 'error_boosty_rejected_30');
      if (response.status === 403) throw new AppError(403, 'boosty_forbidden', 'error_boosty_forbidden_31');
      throw new AppError(502, 'boosty_error', 'error_boosty_error_32');
    }
    if (response.status === 204) return null;
    try {const value = await response.json(); signal?.throwIfAborted(); return value;}
    catch { signal?.throwIfAborted(); throw new AppError(502, 'upstream_response', 'error_upstream_response_33'); }
  }

  async sendCode(deviceId, phone, resend = false) {
    const body = new URLSearchParams({ phone, device_os: 'web', device_id: deviceId });
    if (resend) body.set('transport', 'gate');
    const response = await this.#call('auth/phone/verification_code/send', {
      method: 'POST', body, session: { deviceId },
    });
    const challenge = response?.data?.phoneCode;
    if (typeof challenge?.code !== 'string' || !challenge.code) {
      throw new AppError(502, 'upstream_response', 'error_upstream_response_34');
    }
    return { code: challenge.code, expiresIn: Number(challenge.expiresIn) || 180 };
  }

  async verifyCode(deviceId, phone, challenge, code) {
    const response = await this.#call('auth/phone/verification_code/confirm', {
      method: 'PUT', session: { deviceId }, body: new URLSearchParams({ phone,
        code: challenge, sms_code: code, device_os: 'web', device_id: deviceId }),
    });
    if (typeof response?.access_token !== 'string' || !response.access_token
      || typeof response.refresh_token !== 'string' || !response.refresh_token) {
      throw new AppError(502, 'upstream_response', 'error_upstream_response_35');
    }
    return { accessToken: response.access_token, refreshToken: response.refresh_token, deviceId,
      expiresAt: Number(response.expires_in) > 0 ? this.#now() + Number(response.expires_in) * 1000 : null };
  }

  async #refresh(session, oldToken) {
    if (session.accessToken !== oldToken) return;
    if (this.#refreshes.has(session)) return this.#refreshes.get(session);
    if (!session.refreshToken) throw new AppError(401, 'reconnect', 'error_reconnect_36');
    const refresh = (async () => {
      const response = await this.#call('oauth/token/', { method: 'POST',
        session: { deviceId: session.deviceId }, body: new URLSearchParams({ device_id: session.deviceId,
          device_os: 'web', grant_type: 'refresh_token', refresh_token: session.refreshToken }),
      });
      if (typeof response?.access_token !== 'string' || !response.access_token) {
        throw new AppError(502, 'upstream_response', 'error_upstream_response_37');
      }
      session.accessToken = response.access_token;
      if (typeof response.refresh_token === 'string' && response.refresh_token) session.refreshToken = response.refresh_token;
      session.expiresAt = Number(response.expires_in) > 0 ? this.#now() + Number(response.expires_in) * 1000 : null;
      await this.#onUpdate(session);
    })();
    this.#refreshes.set(session, refresh);
    try { await refresh; }
    finally { this.#refreshes.delete(session); }
  }

  async request(session, path, options = {}) {
    options.signal?.throwIfAborted();
    if (session.expiresAt && session.expiresAt < this.#now() + 30000) await this.#waitRefresh(session, session.accessToken, options.signal);
    const oldToken = session.accessToken;
    try { return await this.#call(path, { ...options, session }); }
    catch (error) {
      if (error.status !== 401) throw error;
      await this.#waitRefresh(session, oldToken, options.signal);
      return this.#call(path, { ...options, session });
    }
  }

  async #waitRefresh(session, oldToken, signal) {
    signal?.throwIfAborted();
    const refresh = this.#refresh(session, oldToken);
    if (!signal) return refresh;
    let abort;
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, {once: true});
    });
    try {await Promise.race([refresh, cancellation]); signal.throwIfAborted();}
    finally {signal.removeEventListener('abort', abort);}
  }
}
