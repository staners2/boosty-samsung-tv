import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeConfig} from '../server/config.mjs';

test('runtime configuration validates its public and storage boundaries', () => {
  const value = runtimeConfig({PUBLIC_URL: 'https://tv.example.org', BASE_PATH: '/reader', PORT: '9000', NODE_ENV: 'production', VAULT_KEY_FILE: '/run/key'});
  assert.equal(value.publicUrl, 'https://tv.example.org');
  assert.equal(value.basePath, '/reader'); assert.equal(value.port, 9000);
  assert.equal(value.keyPath, '/run/key');
  for (const url of ['http://192.0.2.10', 'https://u:p@tv.example.org', 'https://tv.example.org/path', 'https://tv.example.org/?q=1']) {
    assert.throws(() => runtimeConfig({PUBLIC_URL: url}), /PUBLIC_URL/);
  }
  for (const prefix of ['/a/b', '/a/', '/..', '/a%20b']) assert.throws(() => runtimeConfig({BASE_PATH: prefix}), /BASE_PATH/);
  for (const port of ['0', '65536', '1.5', '1e3', '9x', ' 90']) assert.throws(() => runtimeConfig({PORT: port}), /PORT/);
  assert.throws(() => runtimeConfig({NODE_ENV: 'production'}), /VAULT_KEY_FILE/);
  assert.throws(() => runtimeConfig({NODE_ENV: 'production', VAULT_KEY_FILE: '/run/key'}), /PUBLIC_URL/);
});
