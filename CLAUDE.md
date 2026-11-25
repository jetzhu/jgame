# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Monorepo for the small no-login browser games at https://jgame.duckdns.org. Plain Node (ESM, Node 24 in CI), no
framework, no linter. Each `games/<name>/` and `services/<name>/` folder is self-contained (own `package.json`,
`node_modules`, build and tests). The root `README.md` and `games/chess/README.md` describe features and operations in
detail. Read them before changing deploy or online-play behavior.

## Commands

```
tools/check.sh                       # from repo root: npm ci + build + test for every game/service (exactly what CI and deploy run)

cd games/chess
npm install && npm run build         # esbuild bundle -> public/app.js, plus vendor assets, openings.json, source tarball
npm test                             # node --test 'test/**/*.test.js'
node --test test/room-core.test.js   # a single test file
node --test --test-name-pattern='resign' test/server.test.js   # a single test by name
PORT=3200 node server.js             # local run at http://127.0.0.1:3200/

cd services/stun && npm test
```

Server tests (`test/helpers.js`) spawn `server.js` on port 0 and drive it over HTTP and WebSocket. `SERVER_HOSTING=on|off`
forces server-hosted availability, bypassing the machine-load check.

## Deployment

There is no manual deploy step. A push to `main` is live within about a minute: `jgame-deploy.timer` on the host runs
`deploy/deploy.sh`, which exports the commit to `~/srv/jgame/releases/<sha>`, runs `tools/check.sh`, swaps the `current`
symlink, installs systemd units, the Caddy route and the landing page, then health-checks every entry in
`deploy/services.txt`. It rolls back on failure and records the bad sha in `~/srv/jgame/failed`, so that commit is not
retried (`FORCE=1` retries it). Because of this:

- A red `tools/check.sh` blocks the deploy. Run it before pushing.
- Change `deploy/caddy/jgame.caddy`, `deploy/systemd/*` and `site/` in the repo, never their installed copies.
- Deploy log: `journalctl --user -u jgame-deploy`. Live commit: `readlink ~/srv/jgame/current`.

To add a game, follow "Adding a game" in the root README: pick a port (chess uses 3100, STUN health uses 3479), add a
systemd unit, a `services.txt` line with a health URL, a Caddy `handle_path` route, and a card in `site/index.html`.

## Chess architecture (`games/chess/`)

- **`src/room-core.js` (`GameRoom`) is the authoritative game logic for online play, and it runs in two places.** In
  server-hosted games, `server.js` runs one per room. In player-hosted games (the default), the creator's *browser* runs
  it. It is transport-agnostic: connections are opaque keys and output goes through `io.send(conn, msg)`. A rules or
  protocol change here affects both modes. Both `room-core.test.js` and `p2p.test.js` (Node acting as a browser host
  over the relay) exercise it.
- **`server.js`** serves `public/`, `/status` and `/healthz`, and handles WebSocket `/ws`. For player-hosted rooms it
  only introduces peers (WebRTC signaling) and relays traffic when a direct link fails. It also handles host takeover
  epochs: if the host vanishes, the seated guest re-hosts under a higher epoch, and a returning old host is demoted to a
  regular player. It advertises STUN servers. Ours (`services/stun`, UDP 3478) is preferred, and the public fallback is
  listed only while ours does not answer.
- **`src/main.js`** is the whole client UI: one large file split into `// ----` sections. Online state lives in
  `S.online.kind`, which is `'server'`, `'host'` or `'guest'`. `p2p.js` handles the WebRTC data channel. `net.js` is a
  reconnecting WebSocket. `engine.js` wraps Stockfish WASM, which runs in the browser and never on the server.
- **Learning tools:** `analysis.js` holds the pure scoring math (win %, accuracy, move classes). `analysis-view.js`
  holds the analysis UI and live engine lines. `explain.js` writes plain-language move reasons. `library.js` stores game
  history and spaced-repetition puzzles behind an injected `{get,set}` store, so tests can run it without
  `localStorage`. `puzzle-view.js` is the puzzle UI. Engine help is never offered during a live game.
- **Build output is git-ignored** (`public/app.js`, `public/vendor/`, the license copies and the source tarball).
  `build.mjs` also rewrites the `?v=<hash>` cache-busters inside the tracked `public/index.html` and
  `public/about.html`.
- **GPL compliance:** `build.mjs` builds `chess-playground-source.tar.gz` from an explicit file list (`src`, `test`,
  `data`, and named `public/` files). When you add a top-level source file or a hand-written `public/` file, add it to
  that list. When you add a bundled dependency, update `THIRD-PARTY-LICENSES.txt` generation and `about.html`.
- **Server-hosted rooms are in memory only.** A deploy or restart ends them. Player-hosted games survive restarts.
