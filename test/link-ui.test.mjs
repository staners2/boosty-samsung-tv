import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import {parseHTML} from 'linkedom';

test('phone language toggle retains the typed number and localizes a pending response', async () => {
  const {document, window} = parseHTML(await readFile('web/link/index.html', 'utf8'));
  const bundle = await build({entryPoints: ['web/link/app.js'], bundle: true, format: 'iife', write: false, target: 'es2019'});
  let resolve, calls = 0;
  const fetch = async () => {calls++; return new Promise(done => {resolve = done;});};
  runInNewContext(bundle.outputFiles[0].text, {document, window, fetch, location: {pathname: '/link/' + 'a'.repeat(24), hash: '#' + 'b'.repeat(43)}, history: {replaceState() {}}, AbortController, setTimeout, clearTimeout});
  document.getElementById('phone').value = '+15550123456';
  assert.equal(document.getElementById('send').textContent, 'Get code');
  document.getElementById('language').onclick();
  assert.equal(document.getElementById('phone').value, '+15550123456'); assert.equal(calls, 1);
  resolve(Response.json({name: 'Living room', state: 'waiting'}));
  await new Promise(done => setImmediate(done));
  assert.equal(document.getElementById('send').textContent, 'Получить код');
  assert.equal(document.getElementById('status').textContent, 'Войди в свой аккаунт Boosty.');
});
