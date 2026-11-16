# Chess Playground

Browser chess with no login: https://jgame.duckdns.org/chess_playground/

- **vs Computer**: Stockfish 19 (lite, WASM) runs in the player's browser, with 10 levels. Includes hints, takebacks, and premoves.
- **Play a Friend Online**: creates a share link (`?room=XXXX`). The first visitor takes the free seat and later visitors watch. Clocks run on the server, and the game has chat, draw offers, resign/abort, and rematch with colors swapped. A refresh or reconnect keeps your seat (a per-room token is kept in localStorage).
- **Pass & Play**: two players on one device, with optional clocks and auto-flip.
- Common features: move list with review (arrow keys), flip board (F), PGN copy, sounds, board color themes (gear button), and games vs the computer or pass-and-play resume after a refresh.
- `about.html`: credits, licenses, privacy, and a source download. The project is GPL-3.0-or-later because it bundles GPL code (chessground, Stockfish).

## Layout

```
server.js        Node http + WebSocket server (static files from public/, rooms at /ws)
src/*.js         client source (chessground board, chess.js rules, engine/net/sound)
build.mjs        esbuild bundle -> public/app.js; copies Stockfish, piece CSS, licenses; makes source tarball
public/          what gets served (build output is git-ignored)
test/            integration tests (npm test)
```

## Develop

```
npm install && npm run build && npm test
PORT=3200 node server.js     # http://127.0.0.1:3200/
```

Deployment is automatic on push to `main`. See the repo root README. In production the server runs as the user unit
`chess-playground.service` (`deploy/systemd/`) on `127.0.0.1:3100`, and Caddy maps `/chess_playground/*` to it with the prefix stripped.
Online rooms live only in memory, so a deploy or restart ends any games in progress. Idle rooms are dropped after 24 h, or 2 h with nobody connected.
