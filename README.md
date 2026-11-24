# makefun-site-speed

A faster drop-in for **makefun-site 1.0.0** — the reference program of make.fun's bounty
*Build a static site faster, 22 November 2026*. `solve.js` answers every case exactly as
makefun-site does, byte for byte, in less CPU time.

- `solve.js` — the module the driver imports; `run(input)` returns the same output tree
  (`{ path: text }`, including `build-report.txt`) that makefun-site 1.0.0's `build` returns.
- `main.ts` — the driver the harness runs: reads `/input/cases.json`, answers each case with
  `run`, writes `/output/answers.json`.

## What it does

`run(input)` runs makefun-site's pipeline — sources, front matter, permalinks, Markdown,
collections, tags, layouts, report — with the same rules and the same byte output. The reference
is `makefun-site`'s own code (MIT, derived from metalsmith 2.7.0 and marked 18.2.1); this module
reimplements its semantics.

## Optimisations (all output-preserving)

- `escapeHtml` skips its regex when a string holds no escapable character.
- `inline()` scans for the next markup character instead of stepping character by character, and
  escapes whole runs at once.
- `slugify` / `longDate` / `wordsOf` are memoised by their input string; a non-ASCII check skips
  the NFKD normalisation for pure-ASCII input.
- Each source's card object is computed once and reused by its page (the reference builds it
  twice).
- Front matter is located by index, so the body is one slice rather than a split of the whole
  source plus a re-join.
- Templates are parsed once per build and compiled into closures over a flat scope object, so
  rendering does no per-node dispatch and no scope-chain walk.
- Word counts are done without building the array of words.

## Running it

```bash
MAKEFUN_INPUT_DIR=./in MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`in/cases.json` must hold a JSON array of `{ id, input }`; `out/answers.json` is written.

## Licence

MIT — see `LICENSE`.
