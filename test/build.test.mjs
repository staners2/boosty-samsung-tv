import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

test('build rejects untrusted backend URLs before generating a package', () => {
  for (const publicUrl of ['javascript:alert(1)', 'http://192.0.2.10', 'https://user:password@tv.example', 'https://tv.example/path']) {
    const result = spawnSync(process.execPath, ['scripts/build.mjs'], {env: {...process.env, PUBLIC_URL: publicUrl}, encoding: 'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /PUBLIC_URL/);
  }
});

test('build produces a self-contained Tizen package and hosted phone/TV clients', async () => {
  const result = spawnSync(process.execPath, ['scripts/build.mjs'], {env: {...process.env, PUBLIC_URL: 'https://tv.example', BASE_PATH: '/boosty-tv'}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const html = await readFile('dist/wgt/index.html', 'utf8');
  assert.match(html, /\$WEBAPIS\/webapis\/webapis.js/);
  assert.doesNotMatch(html, /\{\{WEBAPIS\}\}/);
  assert.doesNotMatch(await readFile('dist/tv/index.html', 'utf8'), /\$WEBAPIS/);
  assert.match(await readFile('dist/wgt/config.xml', 'utf8'), /https:\/\/tv.example/);
  assert.match(await readFile('dist/wgt/config.js', 'utf8'), /https:\/\/tv.example/);
  assert.match(await readFile('dist/wgt/config.js', 'utf8'), /\/boosty-tv/);
  assert.match(await readFile('dist/link/index.html', 'utf8'), /\{\{BASE_PATH\}\}\/link\/app.js/);
  assert.doesNotMatch(html, /\{\{/);
  assert.ok((await readFile('dist/link/app.js')).length > 1000);
  const packaged = spawnSync(process.execPath, ['scripts/package.mjs'], {encoding: 'utf8'});
  assert.equal(packaged.status, 0, packaged.stderr);
  const listing = spawnSync('unzip', ['-Z1', 'dist/BoostyTV-unsigned.wgt'], {encoding: 'utf8'});
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /^config.xml$/m);
  assert.doesNotMatch(listing.stdout, /node_modules|server\/|vault|package-lock|link\/|author-signature/);
});
