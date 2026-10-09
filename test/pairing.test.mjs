import test from 'node:test';
import assert from 'node:assert/strict';
import { Pairing, normalizePhone } from '../server/pairing.mjs';

test('normalizes Russian and international phone input but rejects invalid numbers', () => {
  assert.equal(normalizePhone('8 (999) 123-45-67'), '+79991234567');
  assert.equal(normalizePhone('9991234567'), '+79991234567');
  assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
  assert.throws(() => normalizePhone('123'), { code: 'invalid_phone' });
  assert.throws(() => normalizePhone('+7999<script>1234567'), { code: 'invalid_phone' });
});

test('phone and TV keys are independent; neither key can access the other side', () => {
  const pairing = new Pairing();
  const pair = pairing.create('Гостиная');
  assert.notEqual(pair.linkKey, pair.pollKey);
  assert.throws(() => pairing.phone(pair.id, pair.pollKey), { code: 'invalid_pair' });
  assert.throws(() => pairing.poll(pair.id, pair.linkKey), { code: 'invalid_pair' });
  assert.equal(pairing.poll(pair.id, pair.pollKey).state, 'waiting');
});

test('expired QR codes cannot issue or claim sessions', () => {
  let clock = 1000;
  const pairing = new Pairing({ now: () => clock });
  const pair = pairing.create('TV');
  clock += 600001;
  assert.throws(() => pairing.phone(pair.id, pair.linkKey), { code: 'expired_pair' });
  assert.throws(() => pairing.finish(pair.id, pair.pollKey), { code: 'invalid_pair' });
});

test('a completed code request can be repeated immediately but overlapping requests are rejected', () => {
  const pairing = new Pairing({ now: () => 1000 });
  const pair = pairing.create('TV');
  pairing.beginSend(pair.id, pair.linkKey);
  assert.doesNotThrow(() => pairing.beginSend(pair.id, pair.linkKey));
  pair.sending = true;
  assert.throws(() => pairing.beginSend(pair.id, pair.linkKey), { code: 'send_busy' });
});

test('verification attempts remain bounded to prevent code brute force', () => {
  const pairing = new Pairing();
  const pair = pairing.create('TV');
  for (let i = 0; i < 5; i++) pairing.beginVerify(pair.id, pair.linkKey);
  assert.throws(() => pairing.beginVerify(pair.id, pair.linkKey), { code: 'attempt_limit' });
});

test('a verified phone does not connect TV until confirmation, and claim works once', () => {
  const pairing = new Pairing();
  const pair = pairing.create('TV');
  assert.throws(() => pairing.finish(pair.id, pair.pollKey), { code: 'not_verified' });
  const session = { accessToken: 'secret-access', refreshToken: 'secret-refresh' };
  pairing.authorize(pair.id, pair.linkKey, session, { id: '1', name: 'Мой профиль' });
  const state = pairing.poll(pair.id, pair.pollKey);
  assert.equal(state.state, 'confirm');
  assert.equal(JSON.stringify(state).includes('secret-access'), false);
  assert.equal(pairing.finish(pair.id, pair.pollKey).session.accessToken, 'secret-access');
  assert.throws(() => pairing.finish(pair.id, pair.pollKey), { code: 'invalid_pair' });
});

test('expired pairs are pruned and the pending pair count is bounded', () => {
  const pairing = new Pairing({ maxPairs: 2 });
  pairing.create('One'); pairing.create('Two');
  assert.throws(() => pairing.create('Three'), { code: 'pair_limit' });
});
