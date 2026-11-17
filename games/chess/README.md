# Chess Playground

Browser chess with no login: https://jgame.duckdns.org/chess_playground/

- **vs Computer**: Stockfish 19 (lite, WASM) runs in the player's browser, with 10 levels. Includes hints, takebacks, and premoves.
- **Play a Friend Online**: creates a share link (`?room=XXXX`). The first visitor takes the free seat and later visitors watch. Clocks, chat, draw offers, resign/abort, and rematch with colors swapped. A refresh or reconnect keeps your seat (a per-room token is kept in localStorage). Two hosting modes, chosen in Settings:
  - **Player-hosted (default):** the creator's browser runs the game (`src/room-core.js`). Guests connect directly over WebRTC (`src/p2p.js`, public STUN, no TURN) or fall back to the server relay. The host saves the game to localStorage, so a host refresh resumes it, and directly connected games don't notice server restarts. If the host vanishes for 45 s, its seated opponent (which receives the room key and seat tokens for this purpose) takes over hosting under a higher epoch. The server then turns a returning old host into a regular player.
  - **Server-hosted:** the server runs the same `GameRoom`. It's offered only while the machine is idle (load ≤ 0.5 per CPU, ≥ 25 % memory free, < 10 active server games; see `/status`).
- **Analysis** (`src/analysis-view.js`, `src/analysis.js`): after any finished game ("Analyze"), or from the home menu's *Analysis Board* (paste PGN/FEN). A background Stockfish pass (depth 12 per position) grades every move (best/excellent/good/inaccuracy/mistake/blunder, from the drop in winning chances), gives each side an accuracy %, and draws an evaluation graph. A second Stockfish shows the top 3 lines live (to depth 22); click a move in a line to play it. Moves you make on the board become a side variation. For mistakes: *Retry this move* (engine hidden until you try) and *Next mistake*. Annotated PGN export. Engine help is offered only for finished games, never during a live one.
- **Abandonment:** two minutes after an opponent's last connection drops, the other player can claim the win or call a draw. Before move 2, claiming aborts the game. This works in both hosting modes.
- **Pass & Play**: two players on one device, with optional clocks and auto-flip.
- Common features: move list with review (arrow keys), flip board (F), PGN copy, sounds, board color themes (gear button), and games vs the computer or pass-and-play resume after a refresh.
- `about.html`: credits, licenses, privacy, and a source download. The project is GPL-3.0-or-later because it bundles GPL code (chessground, Stockfish).

## Layout

```
server.js        Node http + WebSocket server (static files from public/, rooms at /ws)
src/room-core.js authoritative game room shared by server.js and player-hosting browsers
src/p2p.js       WebRTC data-channel link for player-hosted games
src/*.js         rest of the client (chessground board, chess.js rules, engine/net/sound)
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
Server-hosted rooms live only in memory, so a deploy or restart ends those games. Player-hosted games are unaffected (direct links) or pause for a moment and resume (relayed). Idle rooms are dropped after 24 h, or 2 h with nobody connected.
