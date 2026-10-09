import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Vault } from '../server/vault.mjs';

test('persists sessions encrypted with private file permissions and restores them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boosty-vault-'));
  const path = join(dir, 'sessions.enc');
  const key = randomBytes(32);
  const vault = new Vault(path, key);
  assert.deepEqual(await vault.load(), { sessions: {} });
  const data = { sessions: { tv: { accessToken: 'sensitive-test-token', refreshToken: 'refresh-test-token' } } };
  await vault.save(data);
  const raw = await readFile(path, 'utf8');
  assert.equal(raw.includes('sensitive-test-token'), false);
  assert.equal(raw.includes('refresh-test-token'), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await new Vault(path, key).load(), data);
});

test('wrong keys and tampered ciphertext are explicit errors, never empty sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boosty-vault-'));
  const path = join(dir, 'sessions.enc');
  const key = randomBytes(32);
  await new Vault(path, key).save({ sessions: { tv: { accessToken: 'test' } } });
  await assert.rejects(new Vault(path, randomBytes(32)).load(), /хранилищ/);
  await writeFile(path, '{"damaged":true}');
  await assert.rejects(new Vault(path, key).load(), /хранилищ/);
});

test('concurrent writes produce a complete decryptable snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boosty-vault-'));
  const path = join(dir, 'sessions.enc');
  const key = randomBytes(32);
  const vault = new Vault(path, key);
  await Promise.all([vault.save({ sessions: { a: { id: 1 } } }), vault.save({ sessions: { b: { id: 2 } } })]);
  assert.deepEqual(await new Vault(path, key).load(), { sessions: { b: { id: 2 } } });
});
