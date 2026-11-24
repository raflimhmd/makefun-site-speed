// test.mjs — the correctness proof for solve.js, reproducible.
//
//   node test.mjs                 practice set + 12 fresh generated cases (+ timing)
//   node test.mjs --cases 30      how many fresh cases to draw
//   node test.mjs --check-only    no timing, correctness only
//
// What it does:
//  1. answers /opt/makefun/work/io/in/cases.json with solve.js and compares every output tree with
//     /opt/makefun/work/io/out/answers.json (the reference program's answers), deep equal and byte for byte;
//  2. draws fresh cases with the kit's own generator (program/generator/rng.ts + subject/sites.mjs), the way the
//     competition's draw.ts does, and compares solve.js's answer for each with the reference program's
//     (baselines/makefun-site/solve.js), deep equal;
//  3. times both end-to-end through main.ts: `node main.ts` over the practice cases, several rounds each, and reports
//     the median CPU time of each and the ratio.
//
// Paths come from the environment when set: MAKEFUN_KIT, MAKEFUN_IN, MAKEFUN_OUT.

import { readFileSync, mkdtempSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const KIT = process.env.MAKEFUN_KIT ?? '/opt/makefun/kit/site-generator-speed-01-run-20261122-kit';
const IN_DIR = process.env.MAKEFUN_IN ?? '/opt/makefun/work/io/in';
const OUT_DIR = process.env.MAKEFUN_OUT ?? '/opt/makefun/work/io/out';
const RUNS = 5;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1]);
};
const CASES = flag('cases', 12);
const CHECK_ONLY = argv.includes('--check-only');

const { run } = await import(new URL('./solve.js', import.meta.url).href);

/** The first difference between two answer trees, or null when they are equal. */
function firstDiff(a, b, path = '') {
  if (a === b) return null;
  const ta = Object.prototype.toString.call(a);
  const tb = Object.prototype.toString.call(b);
  if (ta !== tb) return `${path}: ${ta} vs ${tb}`;
  if (ta === '[object Object]') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, k)) return `${path}.${k}: missing from solve.js`;
      if (!Object.hasOwn(b, k)) return `${path}.${k}: extra in solve.js`;
      const d = firstDiff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  if (ta === '[object Array]') {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `${path}: differs at char ${i} — solve.js ${JSON.stringify(a.slice(Math.max(0, i - 30), i + 40))} | reference ${JSON.stringify(b.slice(Math.max(0, i - 30), i + 40))}`;
  }
  return `${path}: ${JSON.stringify(a).slice(0, 60)} vs ${JSON.stringify(b).slice(0, 60)}`;
}

let failures = 0;

// ---------------------------------------------------------------- 1. the practice set against its answers
const cases = JSON.parse(readFileSync(join(IN_DIR, 'cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(OUT_DIR, 'answers.json'), 'utf8'));
let passed = 0;
const mine = [];
for (let i = 0; i < cases.length; i++) {
  const got = run(cases[i].input);
  mine.push(got);
  const d = firstDiff(got, expected[i], cases[i].id);
  if (d === null) passed++;
  else {
    failures++;
    console.log(`FAIL ${cases[i].id}: ${d.slice(0, 400)}`);
  }
}
console.log(`practice: ${passed}/${cases.length} cases identical to ${OUT_DIR}/answers.json (deep equal)`);
// byte for byte too, the way main.ts writes them
const bytesEqual = JSON.stringify(mine) === JSON.stringify(expected);
console.log(`practice: answers.json byte for byte: ${bytesEqual ? 'identical' : 'DIFFERENT'} (${JSON.stringify(mine).length} bytes)`);
if (!bytesEqual) failures++;

// ---------------------------------------------------------------- 2. fresh cases, drawn by the kit's generator
const { streamFor } = await import(`${KIT}/program/generator/rng.ts`);
const { generate } = await import(`${KIT}/program/generator/subject/sites.mjs`);
const baseline = await import(`${KIT}/baselines/makefun-site/solve.js`);
const reference = baseline.build ?? baseline.run;

let freshOk = 0;
let freshTotal = 0;
for (let r = 0; r * 3 < CASES; r++) {
  const seed = randomBytes(32).toString('hex');
  for (let k = 0; k < 3 && freshTotal < CASES; k++) {
    const input = JSON.parse(JSON.stringify(generate(streamFor(seed, 'case', k), k)));
    const got = run(JSON.parse(JSON.stringify(input)));
    const want = reference(JSON.parse(JSON.stringify(input)));
    freshTotal++;
    const d = firstDiff(got, want, `fresh seed ${seed.slice(0, 12)} case ${k}`);
    if (d === null) freshOk++;
    else {
      failures++;
      console.log(`FAIL fresh: ${d.slice(0, 400)}`);
    }
  }
}
console.log(`fresh cases (kit generator, seeds drawn here): ${freshOk}/${freshTotal} identical to the reference program`);

// ---------------------------------------------------------------- 3. speed, end to end through main.ts
if (!CHECK_ONLY) {
  const work = mkdtempSync(join(tmpdir(), 'makefun-speed-'));
  const entries = [
    { name: 'reference', dir: join(work, 'ref') },
    { name: 'solve.js', dir: join(work, 'mine') },
  ];
  cpSync(join(HERE, 'main.ts'), join(entries[0].dir, 'main.ts'), { recursive: true });
  cpSync(join(HERE, 'main.ts'), join(entries[1].dir, 'main.ts'), { recursive: true });
  cpSync(join(HERE, 'solve.js'), join(entries[1].dir, 'solve.js'));
  // the house baseline: its own solve.js and the vendor tree it imports, behind the same driver
  cpSync(join(KIT, 'baselines/makefun-site/solve.js'), join(entries[0].dir, 'solve.js'));
  cpSync(join(KIT, 'baselines/makefun-site/vendor'), join(entries[0].dir, 'vendor'), { recursive: true });

  const cpuMs = (e) => {
    const out = join(e.dir, 'out');
    mkdirSync(out, { recursive: true });
    // bash's own `time` over the child: the child's user + system CPU, not the wall clock
    const script = `TIMEFORMAT='%3U %3S'; time ${JSON.stringify(process.execPath)} main.ts >/dev/null 2>/dev/null`;
    const p = spawnSync('bash', ['-c', script], {
      cwd: e.dir,
      env: { ...process.env, MAKEFUN_INPUT_DIR: IN_DIR, MAKEFUN_OUTPUT_DIR: out },
      encoding: 'utf8',
    });
    if (p.status !== 0) throw new Error(`main.ts failed: ${p.stderr}`);
    const m = /([\d.]+)\s+([\d.]+)\s*$/.exec(p.stderr.trim());
    if (m === null) throw new Error(`cannot read cpu time from ${JSON.stringify(p.stderr)}`);
    return (Number(m[1]) + Number(m[2])) * 1000;
  };

  const times = { reference: [], 'solve.js': [] };
  cpuMs(entries[0]);
  cpuMs(entries[1]); // untimed warm-up round, as the heat runs one
  for (let r = 0; r < RUNS; r++) {
    for (const e of r % 2 === 0 ? entries : [...entries].reverse()) times[e.name].push(cpuMs(e));
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const refMed = median(times.reference);
  const mineMed = median(times['solve.js']);
  for (const e of entries) console.log(`${e.name.padEnd(10)} cpu ms per round: ${times[e.name].map((x) => x.toFixed(0)).join(' ')}  median ${median(times[e.name]).toFixed(0)}`);
  console.log(`speed: solve.js is ${(refMed / mineMed).toFixed(2)}x the reference (median of ${RUNS} rounds each, end to end through main.ts)`);
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? 'PASS' : `FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);