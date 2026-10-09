import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createApp } from './app.mjs';
import { Vault } from './vault.mjs';
import {runtimeConfig} from './config.mjs';

const {dataDir, keyPath, port, publicUrl, basePath, staticDir, host} = runtimeConfig();
await mkdir(dataDir, { recursive: true, mode: 0o700 });
let key;
try { key = await readFile(keyPath); }
catch (error) {
  if (error.code !== 'ENOENT' || process.env.VAULT_KEY_FILE) throw error;
  key = randomBytes(32);
  await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
}
const server = await createApp({ publicUrl, basePath, vault: new Vault(join(dataDir, 'sessions.enc'), key), staticDir });
server.listen(port, host, () => console.log(`Boosty TV: ${publicUrl}${basePath}`));
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.all([new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), server.closePreview()]);
    process.exit(0);
  } catch {console.error('Boosty TV shutdown failed.'); process.exit(1);}
});
