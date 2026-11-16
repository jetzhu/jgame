// Build: bundle client JS, copy Stockfish engine, generate board/piece CSS.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const root = path.dirname(new URL(import.meta.url).pathname); // games/chess
const repoRoot = path.resolve(root, '../..');
const nm = (p) => path.join(root, 'node_modules', p);
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

for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
  fs.copyFileSync(nm(`stockfish/bin/${f}`), out(`vendor/${f}`));
}
fs.copyFileSync(nm('stockfish/Copying.txt'), out('vendor/stockfish-COPYING.txt'));

// chessground base CSS + cburnett pieces; also expose pieces as `.pc.<role>.<color>`
// so captured-piece lists outside the board can reuse the same artwork.
const base = fs.readFileSync(nm('chessground/assets/chessground.base.css'), 'utf8');
const pieces = fs.readFileSync(nm('chessground/assets/chessground.cburnett.css'), 'utf8');
const extra = pieces.replaceAll('.cg-wrap piece.', '.pc.');
fs.writeFileSync(out('vendor/board.css'), `${base}\n${pieces}\n${extra}\n`);

// License texts shipped with the site (BSD requires the chess.js notice to accompany the bundle).
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), out('LICENSE.txt'));
const notice = (title, body) => `${'='.repeat(72)}\n${title}\n${'='.repeat(72)}\n\n${body.trim()}\n\n`;
fs.writeFileSync(
  out('vendor/THIRD-PARTY-LICENSES.txt'),
  notice('Chess Playground: third-party software', 'This site bundles or serves the components below. Full GPL-3.0 text: ../LICENSE.txt') +
    notice('chess.js 1.4.0 (BSD-2-Clause) https://github.com/jhlywa/chess.js', fs.readFileSync(nm('chess.js/LICENSE'), 'utf8')) +
    notice(
      'chessground 9.2.1 (GPL-3.0-or-later) https://github.com/lichess-org/chessground',
      'Copyright (C) Thibault Duplessis and lichess.org contributors.\nLicensed under the GNU General Public License v3.0 or later (see ../LICENSE.txt).',
    ) +
    notice(
      'cburnett chess pieces (GPL-2.0-or-later), bundled with chessground',
      'Artwork by Colin M. L. Burnett. https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces',
    ) +
    notice(
      'Stockfish 19 / Stockfish.js 19.0.1 (GPL-3.0) https://github.com/nmrugg/stockfish.js',
      'Copyright (C) the Stockfish developers (https://github.com/official-stockfish/Stockfish) and Nathan Rugg.\nLicensed under the GNU General Public License v3.0 (see stockfish-COPYING.txt).',
    ),
);

// Cache-bust assets in the HTML pages with a content hash (stable across identical builds).
const hash = crypto.createHash('sha256');
for (const f of ['app.js', 'style.css', 'vendor/board.css']) hash.update(fs.readFileSync(out(f)));
const v = hash.digest('hex').slice(0, 10);
for (const page of ['index.html', 'about.html']) {
  const file = out(page);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(app\.js|style\.css|board\.css)(\?v=\w+)?/g, `$1?v=${v}`));
}

// Complete corresponding source for GPL compliance, linked from about.html.
const g = (f) => `games/chess/${f}`;
execFileSync('tar', [
  '-czf', out('chess-playground-source.tar.gz'),
  '--transform', 's,^,jgame/,',
  '-C', repoRoot,
  'LICENSE',
  ...['README.md', 'package.json', 'package-lock.json', 'build.mjs', 'server.js', 'src', 'test'].map(g),
  ...['index.html', 'about.html', 'style.css', 'favicon.svg'].map((f) => g(`public/${f}`)),
]);
console.log('build ok', v);
