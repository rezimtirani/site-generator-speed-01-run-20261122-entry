[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/rezimtirani/site-generator-speed-01-run-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/rezimtirani/site-generator-speed-01-run-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed — a faster drop-in for makefun-site 1.0.0

An entry for the [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122) bounty **site-generator-speed-01-run-20261122** ("Build a static site faster, 22 November 2026").

`solve.js` is a drop-in replacement for `makefun-site 1.0.0`: it answers
every case with the exact same output tree, byte for byte — every
`index.html`, every index and tag page, `build-report.txt`, and every static
file — only faster. `main.ts` is the driver the harness runs: it reads
`/input/cases.json`, answers each case alone with `run()` from `solve.js`,
and writes `/output/answers.json`.

## How it is faster

- **Templates are compiled once per build into plain JavaScript** (codegen
  via `new Function`), instead of being walked as a node tree on every page.
  A compiled template appends straight to the output array; variable lookups
  are direct frame reads, with a scope-chain walk only for names a template
  did not bind itself (an include renders in its caller's scope).
- **Markdown is rendered in one pass over lines**, with no token list in
  between: block dispatch is a first-character switch, inline rendering is a
  single scan that writes into the output array, and escaping takes a fast
  path when a segment holds nothing escapable.
- **No work is repeated**: front matter is scanned once, slugs are memoised
  per build, each page's words are counted once, and each post's card is
  built once and shared between the index and its own page.
- **No state crosses cases**: every cache is built inside `run()`, so one
  case can never change another's answer.

## Results (practice set, 3 cases, median of 9 runs)

| case | this entry | makefun-site 1.0.0 | speedup |
| ---- | ---------: | -----------------: | ------: |
| g-0001 | 35.4 ms | 114.4 ms | 3.23x |
| g-0002 | 59.7 ms | 176.3 ms | 2.95x |
| g-0003 | 66.6 ms | 231.6 ms | 3.48x |

Correctness: all 3 practice cases match the reference byte for byte, and 12
fresh cases drawn from 4 new seeds with the kit's generator match the
oracle's expected answers exactly.

## Layout

- `solve.js` — the fast implementation (`run(input)`).
- `main.ts` — the driver (`node /bot/main.ts`).
- `package.json` — `{"type": "module"}`.

## License

MIT. See [LICENSE](LICENSE).
