import {build} from 'esbuild';
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {publicOrigin, mountPath} from '../server/config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const origin = publicOrigin(process.env.PUBLIC_URL || 'http://localhost:8787');
const prefix = mountPath(process.env.BASE_PATH || '');
const output = join(root, 'dist');
for (const directory of ['tv', 'link', 'wgt', 'server']) await mkdir(join(output, directory), {recursive: true});
for (const name of ['tv', 'link']) {
  await build({entryPoints: [join(root, 'web', name, 'app.js')], outfile: join(output, name, 'app.js'), bundle: true, format: 'iife', target: 'es2019', minify: false, legalComments: 'none'});
  await copyFile(join(root, 'web', name, 'style.css'), join(output, name, 'style.css'));
  const html = await readFile(join(root, 'web', name, 'index.html'), 'utf8');
  await writeFile(join(output, name, 'index.html'), html.replace('{{WEBAPIS}}', ''));
}
await writeFile(join(output, 'tv/config.js'), `globalThis.BOOSTY_TV_API = ${JSON.stringify(origin + prefix)};\n`);
await copyFile(join(root, 'tizen/icon.svg'), join(output, 'tv/icon.svg'));
for (const name of ['app.js', 'config.js', 'style.css']) await copyFile(join(output, 'tv', name), join(output, 'wgt', name));
const tvHtml = await readFile(join(root, 'web/tv/index.html'), 'utf8');
await writeFile(join(output, 'wgt/index.html'), tvHtml.replace('{{WEBAPIS}}', '<script src="$WEBAPIS/webapis/webapis.js"></script>').replaceAll('{{BASE_PATH}}/tv/', ''));
await copyFile(join(root, 'tizen/icon.png'), join(output, 'wgt/icon.png'));
const xml = await readFile(join(root, 'tizen/config.xml'), 'utf8');
await writeFile(join(output, 'wgt/config.xml'), xml.replaceAll('{{API_ORIGIN}}', origin.replaceAll('&', '&amp;')));
await build({
  entryPoints: [join(root, 'server/main.mjs')], outfile: join(output, 'server/main.mjs'),
  bundle: true, platform: 'node', target: 'node24', format: 'esm', legalComments: 'none', minify: true,
  banner: {js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"},
});
console.log(`Built TV, phone and broker for ${origin}${prefix}`);
