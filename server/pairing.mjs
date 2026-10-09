import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.mjs';

export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 40 || !/^[+\d\s()-]+$/.test(value)) {
    throw new AppError(400, 'invalid_phone', 'error_invalid_phone_38');
  }
  let digits = value.replace(/\D/g, '');
  if (!value.trim().startsWith('+')) {
    if (digits.length === 10) digits = `7${digits}`;
    else if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  }
  if (!/^[1-9]\d{9,14}$/.test(digits)) throw new AppError(400, 'invalid_phone', 'error_invalid_phone_39');
  return `+${digits}`;
}

function sameSecret(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Pairing {
  #pairs = new Map();
  #now;
  #maxPairs;
  constructor({ now = Date.now, maxPairs = 100 } = {}) { this.#now = now; this.#maxPairs = maxPairs; }

  create(name) {
    for (const [id, pair] of this.#pairs) if (pair.expiresAt <= this.#now()) this.#pairs.delete(id);
    if (this.#pairs.size >= this.#maxPairs) throw new AppError(429, 'pair_limit', 'error_pair_limit_40');
    const pair = { id: randomBytes(18).toString('base64url'),
      linkKey: randomBytes(32).toString('base64url'), pollKey: randomBytes(32).toString('base64url'),
      deviceId: randomUUID(), name: String(name || 'Samsung TV').slice(0, 64),
      expiresAt: this.#now() + 600000, state: 'waiting', attempts: 0,
      codeExpiresAt: 0, phone: null, challenge: null, session: null, profile: null,
      sending: false, verifying: false };
    this.#pairs.set(pair.id, pair);
    return pair;
  }

  #get(id, key, side) {
    const pair = this.#pairs.get(id);
    if (!pair || !sameSecret(key, side === 'phone' ? pair.linkKey : pair.pollKey)) {
      throw new AppError(404, 'invalid_pair', 'error_invalid_pair_41');
    }
    if (pair.expiresAt <= this.#now()) {
      this.#pairs.delete(id);
      throw new AppError(410, 'expired_pair', 'error_expired_pair_42');
    }
    return pair;
  }

  phone(id, key) { return this.#get(id, key, 'phone'); }

  poll(id, key) {
    const pair = this.#get(id, key, 'tv');
    return { state: pair.state, name: pair.name, expiresAt: pair.expiresAt, profile: pair.profile };
  }

  beginSend(id, key) {
    const pair = this.phone(id, key);
    if (pair.state !== 'waiting') throw new AppError(409, 'already_verified', 'error_already_verified_43');
    if (pair.sending) throw new AppError(409, 'send_busy', 'error_send_busy_44');
    return pair;
  }

  beginVerify(id, key) {
    const pair = this.phone(id, key);
    if (pair.attempts >= 5) throw new AppError(429, 'attempt_limit', 'error_attempt_limit_45');
    if (pair.verifying) throw new AppError(409, 'verify_busy', 'error_verify_busy_46');
    pair.attempts++;
    return pair;
  }

  authorize(id, key, session, profile) {
    const pair = this.phone(id, key);
    if (pair.state !== 'waiting') throw new AppError(409, 'already_verified', 'error_already_verified_47');
    pair.session = session;
    pair.profile = profile;
    pair.phone = null;
    pair.challenge = null;
    pair.state = 'confirm';
  }

  finish(id, key) {
    const pair = this.#get(id, key, 'tv');
    if (pair.state !== 'confirm') throw new AppError(409, 'not_verified', 'error_not_verified_48');
    this.#pairs.delete(id);
    return { session: pair.session, profile: pair.profile };
  }
}
