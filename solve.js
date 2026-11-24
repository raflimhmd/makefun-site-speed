// solve.js — a drop-in replacement for makefun-site 1.0.0's build(), same output byte for byte, less CPU.
//
// The reference is makefun-site 1.0.0 (vendor/makefun-site/index.js and lib/{frontmatter,template,markdown,text}.js).
// Every rule, escape and ordering is kept: only the work needed to reach them is reduced. What is optimised:
//
//   * escapeHtml tests once for an escapable character and returns the string itself when there is none; results are
//     memoised for the build (values repeat: a title shows in <title>, <h1>, a card and the nav).
//   * inline() makes one regex scan for the next special character (markup or HTML-escapeable) instead of stepping
//     character by character, and copies whole plain runs straight through — a plain run holds no escapable
//     character, so escaping it is the identity.
//   * slugify / longDate are memoised by their input string; the NFKD normalisation is skipped for ASCII input.
//   * front matter is located by index, so the body is one slice rather than a split of the whole source re-joined.
//   * the Markdown lexer and renderer are fused: blocks are rendered as they are read, with no token objects.
//   * link resolution is memoised per (source directory, target): the answer depends on the build's page and static
//     index alone, and only the `broken-link` line keeps the source's own path.
//   * each source's card object is built once and reused by its page (the reference builds it twice).
//   * templates are parsed once per build and compiled into closures over one flat, fixed-shape scope object, so a
//     render does no per-node dispatch and no scope-chain walk; loop bindings are slots of that object, so a render
//     allocates only its own scope and its own loop record.
//   * word counts are counted without materialising the array of words.
//   * the caches live only for one run() and are emptied at its start, so nothing carries from one case to the next.

// ---------------------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' (README.md, "Text"). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE_HTML = /[&<>"']/;
const ESCAPABLE_HTML_G = /[&<>"']/g;
const escOne = (c) => ESCAPES[c];

/** Escaped texts of this build, by their text: escaping is a pure function of the string. */
const escaped = new Map();

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  const hit = escaped.get(text);
  if (hit !== undefined) return hit;
  const out = ESCAPABLE_HTML.test(text) ? text.replace(ESCAPABLE_HTML_G, escOne) : text;
  escaped.set(text, out);
  return out;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/** Slugs of this build, by their text. */
const slugs = new Map();
const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing is
 * left.
 */
function slugify(text) {
  const hit = slugs.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  slugs.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Long dates of this build, by their date string. */
const longDates = new Map();

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = longDates.get(date);
  if (hit !== undefined) return hit;
  const a = date.indexOf('-');
  const b = date.indexOf('-', a + 1);
  const res = `${Number(date.slice(b + 1))} ${MONTHS[Number(date.slice(a + 1, b)) - 1]} ${date.slice(0, a)}`;
  longDates.set(date, res);
  return res;
}

/** A whitespace character in JavaScript's own `\s` sense (the set `/\S+/g` splits on), for code points above ASCII. */
const isSpaceAboveAscii = (c) =>
  c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

/** The words of a text: its runs of characters other than whitespace, counted without building them. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13)) inWord = false;
    else if (c < 128) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (isSpaceAboveAscii(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The closing "---" is found by index, so the body is one slice of the source.
 */
function parseFrontMatter(text) {
  const len = text.length;
  if (len < 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45 || (len > 3 && text.charCodeAt(3) !== 10)) {
    return { error: 'no front matter' };
  }
  if (len === 3) return { error: 'the front matter is not closed' };
  let closeStart = -1;
  let bodyStart = len;
  let pos = 4;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      bodyStart = nl === -1 ? len : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  if (closeStart > 4) {
    const fmLines = text.slice(4, closeStart - 1).split('\n');
    for (let j = 0; j < fmLines.length; j++) {
      const line = fmLines[j];
      if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      let raw = m[2] ?? '';
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      if (e !== raw.length) raw = raw.slice(0, e);
      if (KEYS.indexOf(key) === -1) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------------------- Markdown, inline

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const HAS_WS = /\s/;

/** Every character inline() has to stop at: the markup openers and the five HTML-escapeable characters. */
const INLINE_SPECIAL_G = /[\\`*\[&<>"']/g;
const ESC_BY_CODE = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };

/** The first index from `from` where `s` holds `ch` outside a backslash escape, or -1. */
function findUnescapedChar(s, ch, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c === ch) return j;
  }
  return -1;
}

/** The first `**` from `from` outside an escape, or -1. */
function findDoubleStar(s, from) {
  const last = s.length - 2;
  for (let j = from; j <= last; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c === '*' && s[j + 1] === '*') return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  const n = s.length;
  for (let j = from; j < n; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  const re = INLINE_SPECIAL_G;
  re.lastIndex = 0;
  let m = re.exec(s);
  if (m === null) return s; // nothing to render and nothing to escape
  const n = s.length;
  const parts = [];
  let last = 0;
  let i = m.index;
  for (;;) {
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // & < > " ' — an escape, inside a plain run or anywhere else
      if (i > last) parts.push(s.slice(last, i));
      parts.push(ESC_BY_CODE[c]);
      last = i + 1;
      i = last;
    } else if (c === 92) {
      // backslash
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > last) parts.push(s.slice(last, i));
        const e = s.charCodeAt(i + 1);
        parts.push(ESC_BY_CODE[e] ?? s[i + 1]);
        last = i + 2;
        i = last;
      } else i++;
    } else if (c === 96) {
      // `code`
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > last) parts.push(s.slice(last, i));
        parts.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        last = j + 1;
        i = last;
      } else i++;
    } else if (c === 42) {
      // *emphasis* or **strong**
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          if (i > last) parts.push(s.slice(last, i));
          parts.push('<strong>', inline(s.slice(i + 2, j), env), '</strong>');
          last = j + 2;
          i = last;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > last) parts.push(s.slice(last, i));
          parts.push('<em>', inline(s.slice(i + 1, j), env), '</em>');
          last = j + 1;
          i = last;
        } else i++;
      }
    } else {
      // '[' — a link, or the character itself
      const k = findUnescapedChar(s, ']', i + 1);
      const close = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = close === -1 ? '' : s.slice(k + 2, close);
      if (target !== '' && !HAS_WS.test(target)) {
        if (i > last) parts.push(s.slice(last, i));
        parts.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(i + 1, k), env), '</a>');
        last = close + 1;
        i = last;
      } else i++;
    }
    if (i >= n) break;
    re.lastIndex = i;
    m = re.exec(s);
    if (m === null) break;
    i = m.index;
  }
  if (last < n) parts.push(s.slice(last));
  return parts.join('');
}

// ---------------------------------------------------------------------------- Markdown, blocks

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const QUOTE_MARK = /^> ?/;
const TRIM_BOTH = /^[ \t]+|[ \t]+$/g;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether every character of `s` is a space or a tab. */
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(s) {
  let a = 0;
  let b = s.length;
  if (b === 0) return s;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(b - 1);
  if (first !== 32 && first !== 9 && last !== 32 && last !== 9) return s;
  while (a < b) {
    const c = s.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = s.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9 || c0 !== c0) {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    }
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        i++;
        const body = [];
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        const lang = fence[1];
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
        out.push('<pre><code', cls, '>');
        for (let k = 0; k < body.length; k++) out.push(escapeHtml(body[k]), '\n');
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(QUOTE_MARK, ''));
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else out.push('<blockquote>\n<p>', inline(kept.join('\n'), env), '</p>\n</blockquote>\n');
      continue;
    }
    let bullet = null;
    let ordered = null;
    if (c0 === 45 || c0 === 42) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        const m = isOrdered ? ORDERED.exec(cur) : BULLET.exec(cur);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      out.push(isOrdered ? (start !== 1 ? `<ol start="${start}">\n` : '<ol>\n') : '<ul>\n');
      const close = isOrdered ? '</ol>\n' : '</ul>\n';
      for (let k = 0; k < items.length; k++) {
        out.push('<li>', inline(items[k].join('\n'), env), '</li>\n');
      }
      out.push(close);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const cur = lines[i];
      const c1 = cur.charCodeAt(0);
      if (c1 === 32 || c1 === 9) {
        if (isBlankLine(cur)) break;
      } else if (c1 !== c1) break; // the empty line
      else if (c1 === 96) {
        if (FENCE_OPEN.test(cur)) break;
      } else if (c1 === 35) {
        if (headingOf(cur) !== null) break;
      } else if (c1 === 45 || c1 === 42) {
        if (HR.test(cur)) break;
      }
      body.push(trimLine(cur));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push('<p>', html, '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_STANDALONE = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = T_STANDALONE.test(src.slice(lineStart, open)) && T_STANDALONE.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  const t = typeof v;
  if (t === 'string') return v;
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += (k === 0 ? '' : ', ') + textOf(v[k]);
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the flat scope: its first name a slot of the scope, each next one an own property. */
function get(scope, path) {
  let v = scope[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Adds every name the for loops of `nodes` bind to `into`. */
function bindingsOf(nodes, into) {
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.kind === 'for') {
      into.add(n.name);
      bindingsOf(n.body, into);
    } else if (n.kind === 'if') {
      bindingsOf(n.then, into);
      if (n.else !== null) bindingsOf(n.else, into);
    }
  }
  return into;
}

/**
 * Compiles parsed `nodes` into (scope, out) => void, appending text pieces to `out`. `templates` maps a template name
 * to its own compiled renderer; `state.depth` counts includes. `slots` holds every name the build's scope carries, so
 * a path whose first name is absent is known to read undefined and folds away, and a present one needs no ownership
 * test: the scope is made with exactly those slots.
 */
function compileNodes(nodes, templates, state, slots) {
  const fns = [];
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': {
        const t = n.text;
        fns.push((scope, out) => {
          out.push(t);
        });
        break;
      }
      case 'var': {
        const p = n.path;
        if (!slots.has(p[0])) break; // undefined, written as nothing
        if (p.length === 1) {
          const k = p[0];
          fns.push((scope, out) => {
            const v = scope[k];
            if (typeof v === 'string') {
              if (v !== '') out.push(escapeHtml(v));
            } else {
              const t = textOf(v);
              if (t !== '') out.push(escapeHtml(t));
            }
          });
        } else {
          fns.push((scope, out) => {
            const v = get(scope, p);
            if (typeof v === 'string') {
              if (v !== '') out.push(escapeHtml(v));
            } else {
              const t = textOf(v);
              if (t !== '') out.push(escapeHtml(t));
            }
          });
        }
        break;
      }
      case 'raw': {
        const p = n.path;
        if (!slots.has(p[0])) break;
        if (p.length === 1) {
          const k = p[0];
          fns.push((scope, out) => {
            const v = scope[k];
            if (typeof v === 'string') {
              if (v !== '') out.push(v);
            } else {
              const t = textOf(v);
              if (t !== '') out.push(t);
            }
          });
        } else {
          fns.push((scope, out) => {
            const v = get(scope, p);
            if (typeof v === 'string') {
              if (v !== '') out.push(v);
            } else {
              const t = textOf(v);
              if (t !== '') out.push(t);
            }
          });
        }
        break;
      }
      case 'if': {
        const p = n.path;
        const not = n.not;
        if (!slots.has(p[0])) {
          // undefined is false: one branch is dead for the whole build
          const live = not ? n.then : n.else;
          if (live !== null) {
            const liveFn = compileNodes(live, templates, state, slots);
            fns.push(liveFn);
          }
          break;
        }
        const thenFn = compileNodes(n.then, templates, state, slots);
        const elseFn = n.else === null ? null : compileNodes(n.else, templates, state, slots);
        fns.push((scope, out) => {
          if (truthy(get(scope, p)) !== not) thenFn(scope, out);
          else if (elseFn !== null) elseFn(scope, out);
        });
        break;
      }
      case 'for': {
        const p = n.path;
        if (!slots.has(p[0])) break; // not an array, ever
        const nm = n.name;
        const bodyFn = compileNodes(n.body, templates, state, slots);
        // One record per node, refilled each pass: `loop` is read, never retained by a template.
        const rec = { index: 0, first: false, last: false, length: 0 };
        fns.push((scope, out) => {
          const xs = get(scope, p);
          if (!Array.isArray(xs) || xs.length === 0) return;
          const prev = scope[nm];
          const prevLoop = scope.loop;
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            scope[nm] = xs[k];
            rec.index = k + 1;
            rec.first = k === 0;
            rec.last = k === len - 1;
            rec.length = len;
            scope.loop = rec;
            bodyFn(scope, out);
          }
          scope[nm] = prev;
          scope.loop = prevLoop;
        });
        break;
      }
      case 'include': {
        const nm = n.name;
        fns.push((scope, out) => {
          const t = templates.get(nm);
          if (t !== undefined && state.depth < INCLUDE_DEPTH) {
            state.depth++;
            t(scope, out);
            state.depth--;
          }
        });
        break;
      }
    }
  }
  const len = fns.length;
  if (len === 0) return NOOP;
  if (len === 1) return fns[0];
  if (len === 2) {
    const a = fns[0];
    const b = fns[1];
    return (scope, out) => {
      a(scope, out);
      b(scope, out);
    };
  }
  return (scope, out) => {
    for (let k = 0; k < len; k++) fns[k](scope, out);
  };
}

const NOOP = () => {};

// ---------------------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The directory a source's path is in ("" at the root). */
function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

/** `rel` (a link's path, "/"-separated) from the directory parts `parts` of a source, or null above the root. */
function resolvePath(parts, rel) {
  const segs = rel.split('/');
  const work = parts.length === 0 ? [] : parts.slice();
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (work.length === 0) return null;
      work.pop();
    } else work.push(seg);
  }
  return work.join('/');
}

/** The scheme test a link's target is kept on: "https:", "mailto:", ... */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  // Nothing carries from one case to the next.
  escaped.clear();
  slugs.clear();
  longDates.clear();

  const report = [];
  const templates = new Map();

  // Templates: parsed once per build, in code-unit order of their names, then compiled to closures.
  const tplNodes = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      tplNodes.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const state = { depth: 0 };
  const compiled = new Map();
  /** Every name a render's scope carries: the page's values and every name a template's for loop binds. */
  const slots = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag', 'loop']);
  for (const nodes of tplNodes.values()) bindingsOf(nodes, slots);
  for (const [name, nodes] of tplNodes) compiled.set(name, compileNodes(nodes, compiled, state, slots));

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter; a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    s.data = data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (!s.post) {
      let own;
      for (let d = 0; d < RESERVED.length; d++) {
        const dir = RESERVED[d];
        if (dir !== 'posts' && s.path.startsWith(`${dir}/`)) {
          own = dir;
          break;
        }
      }
      if (own !== undefined) {
        report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
    }
    if (s.post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (s.post ? 'post' : 'page');
    if (!tplNodes.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  for (let k = 0; k < kept.length; k++) sources.push(kept[k]);

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = dir === '' ? new Set(RESERVED) : new Set();
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (let k = 0; k < statics.length; k++) staticPaths.add(statics[k].path);
  const broken = new Set();
  const linkCache = new Map();
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const dir = dirOf(s.path);
    const parts = dir === '' ? [] : dir.split('/');
    const key0 = `${dir}\u0000`;
    const srcPath = s.path;
    const env = {
      link(target) {
        if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const key = key0 + target;
        const hit = linkCache.get(key);
        if (hit !== undefined) {
          if (hit.broken) broken.add(`broken-link ${srcPath} -> ${target}`);
          return hit.url;
        }
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(parts, rel);
        let url = target;
        let isBroken = true;
        if (path !== null) {
          const page = bySource.get(path);
          if (page !== undefined) {
            url = `${page.url}${frag}`;
            isBroken = false;
          } else if (staticPaths.has(path)) {
            url = `${base}/${path}${frag}`;
            isBroken = false;
          }
        }
        linkCache.set(key, { url, broken: isBroken });
        if (isBroken) broken.add(`broken-link ${srcPath} -> ${target}`);
        return url;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (let k = 0; k < sources.length; k++) if (sources[k].post) posts.push(sources[k]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlugTag = new Map();
  const stubs = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const list = s.data.tags;
    if (list === undefined) return [];
    const seen = new Set();
    const out = [];
    for (let k = 0; k < list.length; k++) {
      const name = list[k];
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    const names2 = ownTags(p);
    const refs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlugTag.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlugTag.set(slug, tag);
      }
      tag.posts.push(p);
      refs.push(tag);
    }
    p.tagRefs = refs;
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (s.post) continue;
    const names2 = ownTags(s);
    const refs = [];
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(name);
      let tag = bySlugTag.get(slug);
      if (tag === undefined) {
        tag = stubs.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: '', posts: [] };
          stubs.set(slug, tag);
        }
      }
      refs.push(tag);
    }
    s.tagRefs = refs;
  }
  const tags = [];
  for (const t of bySlugTag.values()) tags.push(t);
  tags.sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it, built once per post.
  const cardOf = (s) => {
    const data = s.data;
    const refs = s.tagRefs;
    const tagOut = new Array(refs.length);
    for (let k = 0; k < refs.length; k++) {
      const t = refs[k];
      tagOut[k] = { name: t.name, slug: t.slug, url: t.url };
    }
    return {
      title: data.title,
      url: s.url,
      date: data.date ?? '',
      date_long: data.date === undefined ? '' : longDate(data.date),
      summary: data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: tagOut,
    };
  };
  const cards = new Map();
  for (let k = 0; k < posts.length; k++) cards.set(posts[k], cardOf(posts[k]));

  /** A page's link record as templates read it. */
  const linkOf = (s) =>
    s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };

  /** A page as its layout reads it. */
  const pageOf = (s) => {
    const card = cards.get(s) ?? cardOf(s);
    const toc = s.toc;
    const tocOut = new Array(toc.length);
    for (let k = 0; k < toc.length; k++) {
      const h = toc[k];
      tocOut[k] = { level: h.level, id: h.id, html: h.html };
    }
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: tocOut,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    allTags[k] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const postCards = new Array(posts.length);
  for (let k = 0; k < posts.length; k++) postCards[k] = cards.get(posts[k]);
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));

  /** The scope every render starts from: one shape, with a slot for each name a template binds. */
  const scopeTemplate = { site: null, tags: null, recent: null, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  for (const name of slots) if (!Object.hasOwn(scopeTemplate, name)) scopeTemplate[name] = undefined;

  const render = (name, vars) => {
    const tpl = compiled.get(name);
    if (tpl === undefined) return null;
    const scope = Object.assign({}, scopeTemplate);
    scope.site = site;
    scope.tags = allTags;
    scope.recent = recent;
    for (const k in vars) scope[k] = vars[k];
    const out = [];
    state.depth = 0;
    tpl(scope, out);
    return out.join('');
  };

  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: postCards.slice((k - 1) * per, k * per),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    const posts2 = t.posts;
    const tagCards = new Array(posts2.length);
    for (let j = 0; j < posts2.length; j++) tagCards[j] = cards.get(posts2[j]);
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: posts2.length, posts: tagCards } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [];
  for (let k = 0; k < report.length; k++) lines.push(report[k]);
  for (const b of broken) lines.push(b);
  lines.sort(byCodeUnits);
  let pageCount = 0;
  for (let k = 0; k < sources.length; k++) if (!sources[k].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}

export const build = run;
export default run;