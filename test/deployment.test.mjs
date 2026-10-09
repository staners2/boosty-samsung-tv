import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const common = ['template', 'boosty-tv', 'charts/boosty-tv', '--set', 'config.publicUrl=https://tv.example.org', '--set', 'image.repository=registry.example.org/boosty-tv', '--set', 'image.tag=0.1.0', '--set', 'secrets.existingSecret=boosty-key'];
const render = (...args) => spawnSync('helm', [...common, ...args], {encoding: 'utf8'});
test('chart enforces single writer and valid configuration', () => {
  assert.equal(render().status, 0);
  for (const setting of ['replicaCount=2', 'config.publicUrl=http://private.example.org', 'config.publicUrl=https://user:pass@example.org', 'config.basePath=/a/b', 'service.targetPort=0', 'image.digest=sha256:bad', 'route.enabled=true,ingress.enabled=true']) assert.notEqual(render('--set', setting).status, 0, setting);
});
test('chart wires prefixed health, read-only key, retained storage and immutable image', () => {
  const result = render('--set', 'config.basePath=/reader', '--set', 'image.tag=', '--set', 'image.digest=sha256:' + 'a'.repeat(64), '--set', 'persistence.existingClaim=existing-data');
  assert.equal(result.status, 0, result.stderr);
  const yaml = result.stdout;
  assert.match(yaml, /registry.example.org\/boosty-tv@sha256:a{64}/);
  assert.match(yaml, /path: "\/reader\/health"/);
  assert.match(yaml, /claimName: "existing-data"/);
  assert.doesNotMatch(yaml, /^kind: (Secret|PersistentVolumeClaim)$/m);
  assert.match(yaml, /replicas: 1/); assert.match(yaml, /type: Recreate/);
  assert.match(yaml, /readOnlyRootFilesystem: true/); assert.match(yaml, /automountServiceAccountToken: false/);
  assert.match(yaml, /value: \/run\/secrets\/boosty\/vault.key/);
  const fresh = render(); assert.equal(fresh.status, 0);
  assert.match(fresh.stdout, /helm.sh\/resource-policy: keep/); assert.match(fresh.stdout, /Prune=false,Delete=false/);
});
test('Compose passes runtime environment without changing internal port', () => {
  const result = spawnSync('docker', ['compose', 'config', '--format', 'json'], {env: {...process.env, PUBLIC_URL: 'https://tv.example.org', BASE_PATH: '/reader', HTTP_PORT: '9876'}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const app = JSON.parse(result.stdout).services.app;
  assert.deepEqual(app.environment, {BASE_PATH: '/reader', DATA_DIR: '/data', HOST: '0.0.0.0', NODE_ENV: 'production', PORT: '8787', PUBLIC_URL: 'https://tv.example.org', STATIC_DIR: '/app/dist', VAULT_KEY_FILE: '/run/secrets/boosty/vault.key'});
  assert.equal(app.ports[0].target, 8787); assert.equal(app.ports[0].published, '9876');
  assert.equal(app.read_only, true);
});
