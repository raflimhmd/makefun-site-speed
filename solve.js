// solve.js — drop-in for makefun-site 1.0.0, same output byte for byte, less CPU.
// Reference semantics: baselines/makefun-site/vendor/makefun-site (index.js + lib/{text,frontmatter,template,markdown}.js).
// Optimisations, all output-preserving:
//   * escapeHtml skips the regex when a string holds no escapable char.
//   * inline() scans for the next markup char instead of stepping char by char, and escapes whole runs at once.
//   * slugify / longDate / wordsOf memoised by their input string (pure functions of it).
//   * each source's card computed once (the reference built it twice: cards + page).
//   * templates compiled to closures over a flat scope object (no per-lookup scope-chain walk, no node switch).

// ------------------------------------------------------------------ text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const NEEDS_ESC = /[&<>"']/;
const ESC_G = /[&<>"']/g;
const escOne = (c) => ESCAPES[c];

export function escapeHtml(text) {
  return NEEDS_ESC.test(text) ? text.replace(ESC_G, escOne) : text;
}

export const SLUG_MAX = 64;
const slugCache = new Map();
const NON_ASCII = /[^\x00-\x7F]/;

export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(/\p{M}/gu, '') : text;
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
  slugCache.set(text, res);
  return res;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateCache = new Map();

export function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const parts = date.split('-');
  const res = `${Number(parts[2])} ${MONTHS[Number(parts[1]) - 1]} ${parts[0]}`;
  dateCache.set(date, res);
  return res;
}

// ------------------------------------------------------------------ front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const KEY_SET = new Set(KEYS);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

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

export function parseFrontMatter(text) {
  const len = text.length;
  if (!(len >= 3 && text.charCodeAt(0) === 45 && text.charCodeAt(1) === 45 && text.charCodeAt(2) === 45 && (len === 3 || text.charCodeAt(3) === 10))) return { error: 'no front matter' };
  if (len === 3) return { error: 'the front matter is not closed' };
  // The front matter runs to the first later line that is exactly "---"; found by index, so the
  // body is one slice instead of a split of the whole source plus a re-join.
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
      if (FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${j + 2} is not "key: value"` };
      const key = m[1];
      let raw = m[2] ?? '';
      const t = raw.length;
      let e = t;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      if (e !== t) raw = raw.slice(0, e);
      if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
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

// ------------------------------------------------------------------ markdown

const MD_BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const HAS_WS = /\s/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(s) {
  let a = 0;
  let b = s.length;
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

function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return FENCE_OPEN.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR.test(line);
  return false;
}

export function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    }
    if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const trimmed = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') trimmed.push(t);
      }
      tokens.push({ type: 'blockquote', lines: trimmed });
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
      const outItems = new Array(items.length);
      for (let k = 0; k < items.length; k++) outItems[k] = items[k].join('\n');
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: outItems });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// The markup characters inline() reacts to: backslash, backtick, asterisk, open bracket.
const MARKUP = /[\\`*[]/;

const MARKUP_G = /[\\`*[]/g;

function nextMarkup(s, from) {
  MARKUP_G.lastIndex = from;
  const m = MARKUP_G.exec(s);
  return m === null ? -1 : m.index;
}

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

const ESC_BY_CODE = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
const SPECIAL_G = /[&<>"']/g;

/** Appends `s` to `parts` with & < > " ' escaped, copying only the runs between them. */
function pushEscaped(parts, s) {
  const re = SPECIAL_G;
  re.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    if (i > last) parts.push(s.slice(last, i));
    parts.push(ESC_BY_CODE[s.charCodeAt(i)]);
    last = i + 1;
  }
  if (last < s.length) parts.push(last === 0 ? s : s.slice(last));
}

export function inline(s, env) {
  if (!MARKUP.test(s)) return escapeHtml(s);
  const parts = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const j = nextMarkup(s, i);
    if (j === -1) {
      pushEscaped(parts, s.slice(i));
      break;
    }
    if (j > i) pushEscaped(parts, s.slice(i, j));
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        pushEscaped(parts, s[i + 1]);
        i += 2;
      } else {
        parts.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        parts.push('<code>');
        pushEscaped(parts, s.slice(i + 1, k));
        parts.push('</code>');
        i = k + 1;
      } else {
        parts.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findDoubleStar(s, i + 2);
        if (k > i + 2) {
          parts.push('<strong>', inline(s.slice(i + 2, k), env), '</strong>');
          i = k + 2;
        } else {
          parts.push('**');
          i += 2;
        }
        continue;
      }
      const k = findSingleStar(s, i + 1);
      if (k > i + 1) {
        parts.push('<em>', inline(s.slice(i + 1, k), env), '</em>');
        i = k + 1;
      } else {
        parts.push('*');
        i++;
      }
      continue;
    }
    // '['
    const k = findUnescapedChar(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !HAS_WS.test(target)) {
      parts.push('<a href="');
      pushEscaped(parts, env.link(target));
      parts.push('">', inline(s.slice(i + 1, k), env), '</a>');
      i = m + 1;
      continue;
    }
    parts.push('[');
    i++;
  }
  return parts.join('');
}

export function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        let body = '';
        for (const l of t.lines) body += escapeHtml(l) + '\n';
        blocks.push(`<pre><code${cls}>${body}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        let body = '';
        for (const item of t.items) body += `<li>${inline(item, env)}</li>\n`;
        blocks.push(`${open}\n${body}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------------ templates, compiled

export const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_STANDALONE = /^[ \t]*$/;

export class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

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

export function parseTemplate(name, src) {
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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += (k === 0 ? '' : ', ') + textOf(v[k]);
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const MISSING = Symbol('missing');

/** A path's value in the flat scope: own properties only, nearest binding first (bindings are own props). */
function get(scope, path) {
  const p0 = path[0];
  if (!Object.hasOwn(scope, p0)) return undefined;
  let v = scope[p0];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * Compiles a parsed template into (scope, out) => void, appending to `out`.
 * `state.depth` counts includes; `templates` maps a name to its compiled renderer.
 */
function compileNodes(nodes, templates, state) {
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
        if (p.length === 1) {
          const k = p[0];
          fns.push((scope, out) => {
            out.push(escapeHtml(textOf(Object.hasOwn(scope, k) ? scope[k] : undefined)));
          });
        } else {
          fns.push((scope, out) => {
            out.push(escapeHtml(textOf(get(scope, p))));
          });
        }
        break;
      }
      case 'raw': {
        const p = n.path;
        if (p.length === 1) {
          const k = p[0];
          fns.push((scope, out) => {
            out.push(textOf(Object.hasOwn(scope, k) ? scope[k] : undefined));
          });
        } else {
          fns.push((scope, out) => {
            out.push(textOf(get(scope, p)));
          });
        }
        break;
      }
      case 'if': {
        const p = n.path;
        const not = n.not;
        const thenFn = compileNodes(n.then, templates, state);
        const elseFn = n.else === null ? null : compileNodes(n.else, templates, state);
        fns.push((scope, out) => {
          const branch = truthy(get(scope, p)) !== not ? thenFn : elseFn;
          if (branch !== null) branch(scope, out);
        });
        break;
      }
      case 'for': {
        const p = n.path;
        const nm = n.name;
        const bodyFn = compileNodes(n.body, templates, state);
        fns.push((scope, out) => {
          const xs = get(scope, p);
          if (!Array.isArray(xs)) return;
          const hadX = Object.hasOwn(scope, nm);
          const prevX = hadX ? scope[nm] : MISSING;
          const hadLoop = Object.hasOwn(scope, 'loop');
          const prevLoop = hadLoop ? scope.loop : MISSING;
          const len = xs.length;
          for (let k = 0; k < len; k++) {
            scope[nm] = xs[k];
            scope.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
            bodyFn(scope, out);
          }
          if (hadX) scope[nm] = prevX;
          else delete scope[nm];
          if (hadLoop) scope.loop = prevLoop;
          else delete scope.loop;
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
  if (len === 0) return (scope, out) => {};
  if (len === 1) {
    const only = fns[0];
    return (scope, out) => {
      only(scope, out);
    };
  }
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

// ------------------------------------------------------------------ the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const wordCache = new Map();
const IS_SPACE = (c) =>
  c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 ||
  c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;

function wordsOf(text) {
  const hit = wordCache.get(text);
  if (hit !== undefined) return hit;
  // Same set as /\S+/g, counted without building the array of words.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space = IS_SPACE(c);
    if (space) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  wordCache.set(text, n);
  return n;
}

function resolvePath(dir, rel) {
  if (dir === '' && rel.indexOf('/') === -1 && rel !== '.' && rel !== '..') return rel;
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export function build(input) {
  const report = [];
  const templates = new Map();

  // Templates, parsed once per build, then compiled to closures.
  const tplNodes = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      tplNodes.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const state = { depth: 0 };
  const compiled = new Map();
  for (const [name, nodes] of tplNodes) compiled.set(name, compileNodes(nodes, compiled, state));

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources
  const sources = [];
  const statics = [];
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    s.data = data;
    s.body = fm.body;
    s.post = s.path.charCodeAt(0) === 112 && s.path.startsWith('posts/');
    if (!s.post) {
      let own;
      for (const d of RESERVED) {
        if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
          own = d;
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
  for (const s of kept) sources.push(s);

  // 3. permalinks
  const bySource = new Map();
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const envLink = {
    link(target) {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirOf(this.srcPath), rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${this.srcPath} -> ${target}`);
      return target;
    },
    srcPath: '',
  };
  for (const s of sources) {
    envLink.srcPath = s.path;
    const md = renderMarkdown(s.body, envLink);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = [];
  for (const s of sources) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags
  const bySlugTag = new Map();
  const ownTags = (s) => {
    const list = s.data.tags ?? [];
    const seen = new Set();
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (const name of names2) {
      const slug = slugify(name);
      let tag = bySlugTag.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlugTag.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  const emptyTagRefs = new Map();
  const tagRefFor = (name) => {
    const slug = slugify(name);
    const real = bySlugTag.get(slug);
    if (real !== undefined) return real;
    let stub = emptyTagRefs.get(slug);
    if (stub === undefined) {
      stub = { name, slug, url: '', posts: [] };
      emptyTagRefs.set(slug, stub);
    }
    return stub;
  };
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map(tagRefFor);
  const tags = [];
  for (const t of bySlugTag.values()) tags.push(t);
  tags.sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // cards, computed once per source and reused by the page
  const cards = new Map();
  const cardOf = (s) => {
    const data = s.data;
    const dateGiven = data.date !== undefined;
    const tagRefs = s.tagRefs;
    const tagOut = new Array(tagRefs.length);
    for (let k = 0; k < tagRefs.length; k++) {
      const t = tagRefs[k];
      tagOut[k] = { name: t.name, slug: t.slug, url: t.url };
    }
    return {
      title: data.title,
      url: s.url,
      date: data.date ?? '',
      date_long: dateGiven ? longDate(data.date) : '',
      summary: data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: tagOut,
    };
  };
  for (const p of posts) cards.set(p, cardOf(p));

  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
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

  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = new Array(tags.length);
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    allTags[k] = { name: t.name, slug: t.slug, url: t.url, count: t.posts.length };
  }
  const recentCount = input.site.recent;
  const recent = new Array(Math.min(recentCount, posts.length));
  for (let k = 0; k < recent.length; k++) recent[k] = cards.get(posts[k]);

  const render = (name, vars) => {
    const tpl = compiled.get(name);
    if (tpl === undefined) return null;
    const scope = { site, tags: allTags, recent };
    for (const k in vars) scope[k] = vars[k];
    const out = [];
    state.depth = 0;
    tpl(scope, out);
    return out.join('');
  };

  // 7. layouts
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const sliceCards = new Array(Math.min(per, posts.length - (k - 1) * per));
    for (let q = 0; q < sliceCards.length; q++) sliceCards[q] = cards.get(posts[(k - 1) * per + q]);
    const html = render('index', {
      posts: sliceCards,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const tagCards = new Array(t.posts.length);
    for (let k = 0; k < t.posts.length; k++) tagCards[k] = cards.get(t.posts[k]);
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: tagCards } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [];
  for (const r of report) lines.push(r);
  for (const r of broken) lines.push(r);
  lines.sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  // Caches are keyed by pure inputs only; cleared so no case borrows another case's work.
  slugCache.clear();
  dateCache.clear();
  wordCache.clear();

  return output;
}

export const run = build;
export default build;