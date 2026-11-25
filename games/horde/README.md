# Horde Gate

A lane-shooter squad game with no login: https://jgame.duckdns.org/horde_gate/

Your squad runs down a three-lane bridge and fires on its own; you steer (and hold Up to run faster). Gates change the squad
(`+N`, `×N` good; `−N`, `÷N` bad), every soldier adds firepower, and every enemy that reaches you
takes soldiers with it. The signature set piece is the slab: a field of gates raised on a concrete
slab over a garage full of the horde. The squad holds in front of it until the pillar is shot
down; the slab then crushes whatever is still underneath and its gates become walkable. Vaults
guard walled lanes of gold gates, pump gates improve while you shoot them, crates give power-ups,
barrels explode. Every 5th level ends with a boss; survivors climb a
×1..×5 coin ramp. Coins buy permanent upgrades. Endless mode runs until you are overrun.

## Layout

```
src/sim.js       the whole game rules: pure, deterministic (seeded RNG, fixed 60 Hz step), no DOM
src/levels.js    level generator: segments sized from the squad a typical player has at that point
src/bot.js       a simple player: balance tests + the demo behind the title screen
src/progress.js  upgrades, costs, rewards, save format (pure)
src/render.js    three.js view; reads the sim each frame (instanced meshes for crowds/bullets)
src/audio.js     synthesized WebAudio effects
src/main.js      screens, input, loop, HUD, localStorage save
server.js        static file server + /healthz (the game runs entirely in the browser)
build.mjs        esbuild bundle -> public/app.js; licenses; cache-busting; GPL source tarball
```

## Develop

```
npm install && npm run build && npm test
PORT=3201 node server.js     # http://127.0.0.1:3201/
```

## Balance

Campaign levels are sized for `expectedStats(level)` in `progress.js` (about one upgrade per level),
not the player's own stats, so upgrades make a level easier. `test/levels.test.js` checks the curve
with the bot: a simulated career (play, earn, upgrade, retry) must clear levels 1–15 in under 4
tries each, an idle player must lose, and a never-upgrading player must stall by level ~20.
Tuning knobs: `soak()` and `early()` in `levels.js` (horde strength), the boss HP in `addBoss()`,
and costs/rewards in `progress.js`.

Deployment is automatic on push to `main` (see the repo root README). In production the server runs as
the user unit `horde-gate.service` on `127.0.0.1:3101`, and Caddy maps `/horde_gate/*` to it.
