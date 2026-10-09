export class Api {
  constructor(origin = '', request = globalThis.fetch.bind(globalThis)) { this.origin = origin; this.request = request; }
  get(path, headers = {}, {signal} = {}) { return this.call(path, 'GET', undefined, headers, signal); }
  post(path, body = {}, headers = {}) { return this.call(path, 'POST', body, headers); }
  async call(path, method, body, headers, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      if (signal?.aborted) throw signal.reason;
      let response;
      try {
        response = await this.request(this.origin + path, {
          method, credentials: 'include', headers: {
            Accept: 'application/json', ...(this.proof ? {'X-TV-Proof': this.proof} : {}), ...headers,
            ...(body ? {'Content-Type': 'application/json', 'X-TV-Request': '1'} : {}),
          },
          ...(body ? {body: JSON.stringify(body)} : {}), signal: controller.signal,
        });
      } catch { if (signal?.aborted) throw signal.reason; throw Object.assign(new Error(messages.en.network_error), {messageKey: 'network_error'}); }
      let value;
      try { value = await response.json(); }
      catch { if (signal?.aborted) throw signal.reason; throw Object.assign(new Error(messages.en.invalid_response), {messageKey: 'invalid_response'}); }
      if (signal?.aborted) throw signal.reason;
      if (!response.ok) {
        const messageKey = Object.prototype.hasOwnProperty.call(messages.en, value?.messageKey) ? value.messageKey : 'request_failed';
        throw Object.assign(new Error(messages.en[messageKey]), {status: response.status, code: value?.code, messageKey});
      }
      return value;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}
import {messages} from '../shared/messages.js';
