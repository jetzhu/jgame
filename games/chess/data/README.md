# data/

- `openings.tsv`: opening names (ECO code, name, moves) from
  [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings), which is
  dedicated to the public domain (CC0). `build.mjs` turns it into
  `public/vendor/openings.json`, a lookup from position to opening name.
