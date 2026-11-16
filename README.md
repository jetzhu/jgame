# jgame

Small browser games served at **https://jgame.duckdns.org**, with no login required.

| Game | Path | Folder |
|---|---|---|
| Chess Playground | [/chess_playground/](https://jgame.duckdns.org/chess_playground/) | `games/chess/` |

## Layout

```
site/                 landing page (synced to the Caddy container's www/jgame)
games/<name>/         one folder per game, self-contained (own package.json, build, tests)
deploy/caddy/         Caddy route file for jgame.duckdns.org (installed + reloaded by deploy.sh)
deploy/systemd/       systemd user units (game servers, deploy timer)
deploy/services.txt   game servers to restart + health-check on each deploy
deploy/deploy.sh      pull-based deploy with automatic rollback
tools/check.sh        npm ci + build + test for every game (CI and deploy both run this)
.github/workflows/    CI on GitHub
```

## Development

```
cd games/chess
npm install
npm run build     # bundles into public/
npm test          # starts the server on a random port and exercises it
PORT=3200 node server.js   # try it locally at http://127.0.0.1:3200/
tools/check.sh    # (from the repo root) what CI and deploy run
```

## Deployment (automatic)

Pushing to `main` is all it takes:

1. GitHub Actions runs `tools/check.sh`.
2. On the server, `jgame-deploy.timer` runs `deploy/deploy.sh` every minute. It fetches `main` (public repo, so no credentials) and exports the new commit to `~/srv/jgame/releases/<sha>`.
3. It runs `tools/check.sh` there. If that fails, nothing changes on the live site.
4. It points `~/srv/jgame/current` at the new release, then installs changed systemd units, syncs `site/`, and installs/validates/reloads the Caddy route if it changed.
5. It restarts each server in `deploy/services.txt` and checks its health URL. If any step after the switch fails, it rolls back to the previous release and records the commit in `~/srv/jgame/failed`, so it isn't retried. Use `FORCE=1` to retry.

The last 5 releases are kept. Useful commands:

```
journalctl --user -u jgame-deploy -f          # deploy log
systemctl --user list-timers jgame-deploy.timer
readlink ~/srv/jgame/current                  # live commit
FORCE=1 ~/srv/jgame/current/deploy/deploy.sh  # redeploy / retry now
```

Rollback by hand: push a revert commit (preferred). Or, for an emergency, point the symlink at an older release:
`ln -sfn releases/<sha> ~/srv/jgame/current && systemctl --user restart chess-playground`.

## Adding a game

1. Create `games/<name>/` with `package.json` scripts `build` and `test`. Static files go in `public/`.
2. If it needs a server: listen on a free `127.0.0.1` port (chess uses 3100, so take the next one), add a unit to
   `deploy/systemd/`, and add a line to `deploy/services.txt` with a health URL.
3. Add a route to `deploy/caddy/jgame.caddy` (`redir /<path> /<path>/ 308` + `handle_path /<path>/* { reverse_proxy 127.0.0.1:<port> }`).
4. Add a card to `site/index.html`.
5. Commit and push. The deploy picks it all up.

## License

GPL-3.0-or-later (see `LICENSE`). Chess bundles GPL components (Stockfish, chessground). Its About page lists the credits.
