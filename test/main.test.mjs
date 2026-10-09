import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('production never replaces a missing or invalid encryption key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boosty-startup-'));
  const key = join(directory, 'key');
  const env = {...process.env, NODE_ENV: 'production', PUBLIC_URL: 'https://tv.example.org', DATA_DIR: join(directory, 'data'), VAULT_KEY_FILE: key};
  for (const bytes of [null, Buffer.alloc(31), Buffer.alloc(33)]) {
    if (bytes) await writeFile(key, bytes);
    const result = spawnSync(process.execPath, ['server/main.mjs'], {env, encoding: 'utf8', timeout: 3000});
    assert.notEqual(result.status, 0); assert.equal(result.error, undefined);
    assert.deepEqual(await readdir(env.DATA_DIR), []);
  }
});
