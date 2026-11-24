// fuzz.mjs — differential fuzz for solve.js: small, deliberately awkward inputs, mine vs the reference program.
//
//   node fuzz.mjs                200 rounds from a fixed seed
//   node fuzz.mjs --rounds 500 --seed 7
//
// Each round draws a whole site by hand (well-formed templates most of the time, broken ones now and then, odd front
// matter, Markdown that the dialect reads and Markdown that it does not) and compares solve.js's answer with
// makefun-site 1.0.0's (kit/baselines/makefun-site/solve.js), deep equal. It is the checker that found the two bugs
// this entry had while it was written; it is not part of the entry.
//
// MAKEFUN_KIT overrides the kit's path.

const KIT = process.env.MAKEFUN_KIT ?? '/opt/makefun/kit/site-generator-speed-01-run-20261122-kit';
const mine = await import(new URL('./solve.js', import.meta.url).href);
const base = await import(`${KIT}/baselines/makefun-site/solve.js`);
const ref = base.build ?? base.run;

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(argv[at + 1]);
};
let s = (flag('seed', 12345) >>> 0) || 1;
function rnd() {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];
const chance = (p) => rnd() < p;

function firstDiff(a, b, path = '') {
  if (a === b) return null;
  const ta = Object.prototype.toString.call(a);
  const tb = Object.prototype.toString.call(b);
  if (ta !== tb) return `${path}: ${ta} vs ${tb}`;
  if (ta === '[object Object]') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, k)) return `${path}.${k}: missing in mine`;
      if (!Object.hasOwn(b, k)) return `${path}.${k}: extra in mine`;
      const r = firstDiff(a[k], b[k], `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (ta === '[object Array]') {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return `${path}: char ${i} — mine ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 50))} | ref ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 50))}`;
  }
  return `${path}: ${String(a).slice(0, 80)} vs ${String(b).slice(0, 80)}`;
}

const TITLES = ['Plain Title', 'a & b', '"Quoted"', 'Café Noir', '東京 物語', '', 'x', '  spaced  ', 'Ærøskøbing', 'a: b', 'T'.repeat(70), "it's", 'back\\slash', 'a [b] c'];
const TAGS = ['[]', '[a]', '[a, b]', '[a,b , c]', '[ ]', '[one, "two"]', '[x[y]]', '[JavaScript, javascript]', '[a,,b]', '[Café, cafe, CAFE]', '[x]'];
const DATES = ['2026-11-09', '1970-01-01', '2099-12-31', '2026-02-29', '2024-02-29', '2026-13-01', '2026-1-1', '20261109', '2026-00-10', '2026-04-31', '2026-12-31', '2018-01-01'];
const LAYOUTS = ['post', 'page', 'wide', 'nope', 'Bad Name', 'p-1', 'tag', 'index'];
const SLUGS = ['ok', 'two-parts', 'Bad Slug', 'x'.repeat(65), 'a-', '-a', 'a--b', 'x'.repeat(64)];

const MD = [
  '# Head', '## Head two', '###### six', '####### seven', '#', '#   spaced   ', '# Head ##', '#Head',
  'para with *em* and **strong** and `code`',
  'a [link](target.md) and [bad](has space) and [none]()',
  'trailing backslash \\', '\\*not em\\* and \\`not code\\`', '\\\\ \\a \\_ \\# \\> \\!',
  '**unclosed strong and *unclosed em', '*a **b** c*', '**a *b* c**', '***bolditalic***', '*a*b*c*',
  '`code with < & > " \'`', '``', '`unclosed',
  '> quote line', '>quote two', '>', '> # heading in quote',
  '- bullet', '* starred', '1. first', '3. third', '1) paren', '- a\n  continued', '1234567890. big',
  '```js', 'code & <tag> "x"', '```', '```', '```  ', '```py',
  '---', '***', '---  ', 'text\n---', '    indented code', 'plain <div class="x">html</div>',
  'under\n===', 'a  \n  b', '', '', '## Head', '## Head',
  '[a](b.md) [c](../c.md) [d](/root) [e](https://x.example/y) [f](mailto:a@b.c) [g](#frag) [h](../a/b.md#x)',
  '[escaped \\] bracket](x.md)', '[a](x.md "t")', '**[link](x.md)**',
  'line with <script>alert(1)</script> & "quotes" and \'apostrophes\'',
  '- [ ] task', '--- not hr ---', '> a\n> b\n\n> c',
];

function bodyOf() {
  const n = int(1, 9);
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(pick(MD));
  return parts.join(pick(['\n\n', '\n', '\r\n\r\n', '\n\n\n']));
}

function frontMatter(valid) {
  if (!valid && chance(0.15)) return pick(['', '---', 'no front matter here\n', '---\ntitle: x\n']);
  const lines = ['---'];
  const t = pick(TITLES);
  const quoted = t.startsWith('"') || t.startsWith('[') || t !== t.trim() || chance(0.3);
  if (quoted) lines.push(`title: "${t.replace(/"/g, '\\"')}"`);
  else if (t === '') lines.push('title: " "');
  else lines.push(`title: ${t}`);
  if (chance(valid ? 0.9 : 0.5)) lines.push(`date: ${valid || chance(0.5) ? pick(['2026-11-09', '1970-01-01', '2099-12-31', '2024-02-29', '2026-12-31', '2018-01-01']) : pick(DATES)}`);
  if (chance(0.4)) lines.push(`tags: ${pick(['[]', '[a]', '[a, b]', '[a,b , c]', '[ ]', '[JavaScript, javascript]', '[Café, cafe, CAFE]', '[x]', '[one, two, three]'])}`);
  if (chance(0.15)) lines.push(pick(['draft: true', 'draft: false', valid ? 'draft: false' : 'draft: yes']));
  if (chance(0.2)) lines.push(`layout: ${pick(valid ? ['post', 'page', 'wide', 'p-1', 'tag', 'index'] : LAYOUTS)}`);
  if (chance(0.15)) lines.push(`slug: ${pick(valid ? ['ok', 'two-parts', 'x'.repeat(64)] : SLUGS)}`);
  if (chance(0.15)) lines.push(`summary: ${pick(['a summary', '"quoted summary"', 'with "quotes"'.replace(/"/g, '\\"')])}`);
  if (chance(0.06)) lines.push('summary: "x\\"y"');
  if (chance(0.06)) lines.push('summary: "x\\\\y"');
  if (!valid) {
    if (chance(0.06)) lines.push('summary: "x\\ty"');
    if (chance(0.05)) lines.push('# a comment');
    if (chance(0.05)) lines.push('');
    if (chance(0.4)) lines.push(pick(['badkey: x', 'Title: x', 'no colon', 'summary:', 'tags:', 'title: "unclosed', 'title: [x]', 'tags: one, two']));
    if (chance(0.1)) lines.pop();
  } else {
    if (chance(0.05)) lines.push('# a comment');
    if (chance(0.05)) lines.push('');
  }
  if (valid || chance(0.5)) lines.push('---');
  return lines.join('\n') + (chance(0.6) ? '\n' : '');
}

const PATHS = ['site.title', 'site.base_url', 'page.title', 'page.content', 'page.date', 'page.date_long', 'page.reading_minutes',
  'page.is_post', 'page.slug', 'page.toc', 'page.tags', 'page.newer', 'page.newer.title', 'page.newer.date_long', 'page.older.url',
  'p.title', 'p.excerpt', 'p.reading_minutes', 'p.tags', 'p.url', 'p.date', 'p.summary', 't.name', 't.url', 't.count', 't.slug',
  't.posts', 'posts', 'pager.number', 'pager.total', 'pager.url', 'pager.newer_url', 'pager.older_url', 'loop.index',
  'loop.first', 'loop.last', 'loop.length', 'tag.name', 'tag.count', 'tag.posts', 'tag.slug', 'tags', 'recent', 'nope.nope',
  'page.toc.length', 'p.tags.length', 'site', 'page', 'p'];

function templateOf(depth, names) {
  const bits = [];
  const n = int(1, 8);
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.24) bits.push(pick(['<div class="c">', '</div>\n', 'text ', '\n', '  ', 'a { b } c', '}}', '<p>x & y</p>', '']));
    else if (r < 0.55) bits.push(`{{ ${pick(PATHS)} }}`);
    else if (r < 0.62) bits.push(`{{{ ${pick(['page.content', 'page.excerpt', 'p.excerpt', 'site.title', 'page.toc', 'page.newer', 'page.title'])} }}}`);
    else if (r < 0.76 && depth < 2) {
      bits.push(`{% for ${pick(['p', 't', 'x', 'page', 'loop', 'q'])} in ${pick(['posts', 'recent', 'tags', 'page.tags', 'page.toc', 'tag.posts', 'p.tags', 'site.title', 'page.pager'])} %}${templateOf(depth + 1, names)}{% endfor %}`);
    } else if (r < 0.9 && depth < 2) {
      bits.push(`{% if ${chance(0.25) ? 'not ' : ''}${pick(['page', 'tag', 'posts', 'pager.number', 'page.tags', 'loop.first', 'p.date', 'recent', 'nope', 'p.summary', 'loop.last'])} %}${templateOf(depth + 1, names)}${chance(0.5) ? `{% else %}${templateOf(depth + 1, names)}` : ''}{% endif %}`);
    } else bits.push(`{% include "${pick(names.length ? names : ['nope'])}" %}`);
  }
  return bits.join('');
}

function makeInput() {
  const layouts = ['post', 'page', 'index', 'tag', 'tags'];
  const names = [...layouts];
  const tcount = int(0, 3);
  for (let k = 0; k < tcount; k++) names.push(`part-${k}`);
  const templates = {};
  const uniq = [...new Set(names)];
  for (let i = 0; i < uniq.length; i++) templates[uniq[i]] = templateOf(0, uniq.slice(i + 1));
  if (chance(0.3)) templates['oops-1'] = pick(['{% if page %}', '{{ bad path }}', '{% for x in %}', '{% include "x" %}{% endif %}', '{{ unclosed', '{% nope %}', '{% else %}']);
  const files = [];
  const nf = int(2, 10);
  for (let k = 0; k < nf; k++) {
    const post = chance(0.6);
    const dir = post ? pick(['posts/', 'posts/2026/', 'posts/x/']) : pick(['', '', 'docs/', 'tags/', 'page/', 'docs/a/']);
    const path = `${dir}${pick(['a', 'b', 'c', 'x y', 'a.b', 'odd', 'dupe'])}-${k}.md`;
    files.push({ path, content: frontMatter(chance(0.8) && (!post || chance(0.95))) + bodyOf() });
  }
  files.push({ path: pick(['assets/x.css', 'index.html', 'robots.txt', 'posts/a/index.html', 'tags/index.html']), content: 'static <&>\n' });
  return {
    site: {
      title: pick(TITLES),
      base_url: pick(['https://x.example', 'https://x.example/', 'https://x.example/blog//', '', 'HTTP://A.b/c']),
      per_page: int(1, 5),
      recent: int(0, 6),
    },
    templates,
    files,
  };
}

const ROUNDS = flag('rounds', 200);
let bad = 0;
const stat = { rounds: 0, files: 0, chars: 0, rendered: 0 };
for (let r = 0; r < ROUNDS; r++) {
  const input = makeInput();
  let a, b;
  try {
    a = mine.run(JSON.parse(JSON.stringify(input)));
  } catch (e) {
    a = { __threw: String(e) };
  }
  try {
    b = ref(JSON.parse(JSON.stringify(input)));
  } catch (e) {
    b = { __threw: String(e) };
  }
  stat.rounds++;
  stat.files += Object.keys(b).length;
  stat.chars += JSON.stringify(b).length;
  if (Object.keys(b).length > 4) stat.rendered++;
  const d = firstDiff(a, b, `round${r}`);
  if (d) {
    bad++;
    console.log('FAIL round', r, d.slice(0, 600));
    if (bad > 4) break;
  }
}
console.log(`rounds ${ROUNDS}, mismatched ${bad}`, JSON.stringify(stat));