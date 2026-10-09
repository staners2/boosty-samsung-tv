import {spawnSync} from 'node:child_process';
import {readFile, unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = join(root, 'dist/wgt');
await readFile(join(directory, 'config.xml'));
const output = join(root, 'dist/BoostyTV-unsigned.wgt');
try { await unlink(output); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const result = spawnSync('zip', ['-q', '-X', output, 'index.html', 'app.js', 'config.js', 'style.css', 'config.xml', 'icon.png'], {cwd: directory, encoding: 'utf8'});
if (result.error || result.status !== 0) throw new Error('Не удалось собрать WGT. Установи zip и выполни npm run build.', {cause: result.error});
console.log(`Unsigned package: ${output}\nSamsung signing profile is required before installation.`);
