// Build: bundle client JS (with three.js), license files, cache-busting, GPL source tarball.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const root = path.dirname(new URL(import.meta.url).pathname); // games/horde
const repoRoot = path.resolve(root, '../..');
const out = (p) => path.join(root, 'public', p);
fs.mkdirSync(out('vendor'), { recursive: true });

await build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  minify: true,
  sourcemap: true,
  format: 'esm',
  target: ['es2020'],
  outfile: out('app.js'),
  logLevel: 'info',
});

// License texts shipped with the site.
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), out('LICENSE.txt'));
const threeVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/three/package.json'), 'utf8')).version;
const notice = (title, body) => `${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n\n${body.trim()}\n\n`;
fs.writeFileSync(
  out('vendor/THIRD-PARTY-LICENSES.txt'),
  notice('Horde Gate: third-party software', 'Horde Gate itself is GPL-3.0-or-later (../LICENSE.txt). It bundles:') +
    notice(`three.js ${threeVersion} (MIT) https://threejs.org`, fs.readFileSync(path.join(root, 'node_modules/three/LICENSE'), 'utf8')),
);

// Cache-bust assets in the HTML pages with a content hash (stable across identical builds).
const hash = crypto.createHash('sha256');
for (const f of ['app.js', 'style.css']) hash.update(fs.readFileSync(out(f)));
const v = hash.digest('hex').slice(0, 10);
for (const page of ['index.html', 'about.html']) {
  const file = out(page);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(app\.js|style\.css)(\?v=\w+)?/g, `$1?v=${v}`));
}

// Complete corresponding source for GPL compliance, linked from about.html.
const g = (f) => `games/horde/${f}`;
execFileSync('tar', [
  '-czf', out('horde-gate-source.tar.gz'),
  '--transform', 's,^,jgame/,',
  '-C', repoRoot,
  'LICENSE',
  ...['README.md', 'package.json', 'package-lock.json', 'build.mjs', 'server.js', 'src', 'test'].map(g),
  ...['index.html', 'about.html', 'style.css', 'favicon.svg'].map((f) => g(`public/${f}`)),
]);
console.log('build ok', v);
