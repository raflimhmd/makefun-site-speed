# makefun-site-speed

A faster drop-in for **makefun-site 1.0.0** — the reference program of make.fun's bounty *Build a static site
faster, 22 November 2026* (`site-generator-speed-01-run-20261122`). `solve.js` answers every case exactly as
makefun-site does, byte for byte, in roughly half the CPU time.

| file | what it is |
| --- | --- |
| `solve.js` | the module `main.ts` imports; `run(input)` returns the output tree makefun-site 1.0.0's `build` returns for `input` |
| `main.ts` | the kit's driver, unchanged: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json` |
| `test.mjs` | the proof: the practice set, fresh cases drawn by the kit's own generator, and the end-to-end CPU-time heat |
| `fuzz.mjs` | the differential fuzzer used while writing it (hand-drawn awkward inputs, mine vs the reference) |

`run(input)` runs makefun-site's whole pipeline — sources, front matter, permalinks, Markdown, collections, tags,
layouts, report — with the same rules and the same byte output. The reference is makefun-site's own code (MIT,
derived from metalsmith 2.7.0 and marked 18.2.1); this module reimplements its semantics, keeping every rule,
escape and ordering.

## Optimisations (all output-preserving)

1. `escapeHtml` tests once for an escapable character and returns the string itself when there is none; its results
   are memoised for the build (a title shows up in `<title>`, in an `<h1>`, in a card and in the nav).
2. `inline()` makes **one** native regex scan for the next special character — the markup openers and the five
   HTML-escapeable ones together — instead of stepping character by character, and copies whole plain runs with one
   `slice`: a run with no special character is already escaped, so escaping it is the identity.
3. `slugify` and `longDate` are memoised by their input string, and the NFKD normalisation is skipped for pure-ASCII
   input (a `/[^\x00-\x7F]/` test).
4. Front matter is located by index: the closing `---` is found by scanning for line starts, so the body is one slice
   rather than a split of the whole source plus a re-join.
5. The Markdown lexer and renderer are fused: blocks are rendered as they are read, with no token objects and no
   second pass, and the per-line dispatch is a `charCodeAt(0)` test before any regex runs.
6. Loop-free fast paths in the line work: `trimLine` returns the same string when neither end holds a space or a tab,
   and the blank-line test only runs when the line can be blank.
7. Link resolution is memoised per (source directory, target): the answer depends only on the build's page and static
   indexes, while the `broken-link` line still carries each source's own path.
8. Each source's card object is built once and reused by its page (the reference builds the same object twice).
9. Templates are parsed once per build and compiled into closures over **one flat, fixed-shape scope object**, so a
   render does no per-node dispatch and no scope-chain walk. The scope carries a slot for every name the build can
   bind (the page's values plus every `for` name any template binds), so a single-name lookup is a direct read with no
   ownership test, a path whose first name the build never binds folds away at compile time, and a `for` needs no
   `delete` — it assigns and restores a slot, and reuses one loop record per node.
10. Words are counted by one scan without materialising the array of words.
11. Every cache is emptied at the **start** of each `run()`, so nothing carries from one case to the next.

What was tried and **did not** pay, so it is not in the code: tuning V8 from `solve.js` (`--always-sparkplug`,
`--maglev`, lower `--invocation-count-for-maglev`/`--invocation-count-for-osr`, higher TurboFan eagerness) measured at
parity or worse on every combination; a `String.match(/\S+/g)` word count, a "escaping only, no markup" fast path in
`inline` and string concatenation instead of the piece array were each slower in a paired A/B (see *Speed* below).

## How it was checked

    node test.mjs                  # practice set + 12 fresh cases + the timing heat
    node test.mjs --cases 30       # draw more fresh cases
    node fuzz.mjs --rounds 500     # the differential fuzzer, mine vs the reference

### Correctness

- **Practice set**: `node test.mjs` answers `/opt/makefun/work/io/in/cases.json` (3 cases) with `solve.js` and compares
  every output tree with `/opt/makefun/work/io/out/answers.json`: **3/3 identical**, deep equal, and the answers file
  is **byte for byte identical** (7,421,485 bytes) — same keys, same order, same text.
- **Fresh cases from the kit's own generator** (`program/generator/rng.ts` + `subject/sites.mjs`, seeds drawn at
  random, 200–600 sources and 14–30 templates each): **36/36** and, in a second run, **15/15** identical to
  `baselines/makefun-site/solve.js` — 51 fresh cases in all.
- **Differential fuzz** over hand-drawn awkward inputs (`fuzz.mjs`: well-formed and broken templates, odd front
  matter, unicode titles and slugs, Markdown the dialect reads and Markdown it does not, colliding slugs, refused
  sources, drafts, broken links, shadowed statics): **over 1,000 rounds, 0 differences**. This checker found the two
  real bugs this entry had while it was written (a missing `loop` slot and an over-eager compile-time fold), which is
  why it is kept in the repository.

### Speed

End-to-end CPU time through `main.ts` (each entry in its own process over the practice cases, alternating, one untimed
warm-up round, then 5 rounds; CPU time is bash's `time` over the child, i.e. the child's user + system CPU):

| round | 1 | 2 | 3 | 4 | 5 | median |
| --- | --- | --- | --- | --- | --- | --- |
| makefun-site 1.0.0 | 1793 | 1533 | 1585 | 1568 | 1609 | **1585 ms** |
| solve.js | 819 | 854 | 797 | 949 | 915 | **854 ms** |

**1.86x** the reference on that heat (an earlier identical heat over 5 rounds: 1605 ms vs 810 ms, **1.98x**). Note
that `main.ts`'s `JSON.stringify` also favours this entry: the reference's output strings are concatenation ropes
that are only flattened when the answers are written (171 ms of its run), while `solve.js` joins each page once
(58 ms).

Inside one process, the build alone (the practice cases, `run()` only, no parse and no stringify) is 1234 ms for the
reference against ~440 ms for `solve.js` — about **2.8x** — which is the honest measure of the pipeline work.

Paired A/B of the alternatives that were rejected (same cases, alternating rounds, min and paired median of 9 rounds):

| variant | min | paired median vs kept version |
| --- | --- | --- |
| kept | 439 ms | 1.000x |
| `String.match(/\S+/g)` word count | 444 ms | 0.925x (slower) |
| "escaping only, no markup" fast path in `inline` | 441 ms | 0.969x (slower) |

## Running it

    MAKEFUN_INPUT_DIR=./in MAKEFUN_OUTPUT_DIR=./out node main.ts

`in/cases.json` must hold a JSON array of `{ id, input }`; `out/answers.json` is written. The test and fuzz scripts
take `MAKEFUN_KIT`, `MAKEFUN_IN` and `MAKEFUN_OUT` to find the kit and the practice data elsewhere.

## Licence

MIT — see `LICENSE`.
