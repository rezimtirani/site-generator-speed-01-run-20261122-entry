// A faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README (the dialect spec) and the reference
// behaviour it describes: for every case's input, run(input) returns exactly
// the output tree makefun-site 1.0.0's build returns, byte for byte. The speed
// comes from three changes, not from different answers:
//   - templates are compiled once per build into small functions that append
//     to an output array, instead of being walked node by node on every page;
//   - Markdown is rendered in one pass over the lines, without building a
//     token list first, and inline text is escaped in whole runs instead of
//     one character at a time;
//   - slugs are memoised per build, and the front matter is scanned without
//     splitting the whole source twice.
// Nothing is kept from one case to the next: every run builds its own state.

/* ------------------------------------------------------------------ text */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_RE = /[&<>"']/g;
const ESCAPE_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped, and nothing else. */
function escHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(ESCAPE_RE, (c) => ESCAPES[c]);
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;
const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Results are memoised in `cache` for this build.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
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
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether code unit `c` is whitespace, exactly as \s has it. */
function isWs(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 160 ||
    c === 5760 ||
    (c >= 8192 && c <= 8202) ||
    c === 8232 ||
    c === 8233 ||
    c === 8239 ||
    c === 8287 ||
    c === 12288 ||
    c === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      c === 32 ||
      (c >= 9 && c <= 13) ||
      c === 160 ||
      c === 5760 ||
      (c >= 8192 && c <= 8202) ||
      c === 8232 ||
      c === 8233 ||
      c === 8239 ||
      c === 8287 ||
      c === 12288 ||
      c === 65279
    )
      inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** The directory of a path ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolveRel(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/* ----------------------------------------------------------- front matter */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
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
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is the
 * source after the closing line, as one string.
 */
function parseFm(text) {
  let e = text.indexOf('\n');
  const first = e === -1 ? text : text.slice(0, e);
  if (first !== '---') return { error: 'no front matter' };
  let pos = e === -1 ? text.length : e + 1;
  let closeStart = -1;
  let closeEnd = -1;
  while (pos <= text.length) {
    e = text.indexOf('\n', pos);
    const line = e === -1 ? text.slice(pos) : text.slice(pos, e);
    if (line === '---') {
      closeStart = pos;
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    if (e === -1) break;
    pos = e + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const lines = text.slice(0, closeStart).split('\n');
  const data = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

/* --------------------------------------------------------------- markdown */

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
/** A line without its leading and trailing spaces and tabs. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// Block kinds: 0 blank, 1 fence, 2 heading, 3 thematic break, 4 blockquote,
// 5 bullet list, 6 ordered list, 8 paragraph.
function blockKind(line) {
  if (line.length === 0) return 0;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return BLANK.test(line) ? 0 : 8;
  if (c0 === 96 && line.startsWith('```')) return FENCE_OPEN.test(line) ? 1 : 8;
  if (c0 === 35) return headingOf(line) !== null ? 2 : 8;
  if (line.startsWith('---') || line.startsWith('***')) return HR.test(line) ? 3 : 8;
  if (c0 === 62) return 4;
  if (line.startsWith('- ') || line.startsWith('* ')) return 5;
  if (c0 >= 48 && c0 <= 57) return ORDERED.test(line) ? 6 : 8;
  return 8;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsPara(line) {
  const k = blockKind(line);
  return k === 0 || k === 1 || k === 2 || k === 3;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnesc(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
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

/**
 * `s` rendered inline into `out`; `link(target)` is a link's href. Plain
 * runs are escaped in one replace per run instead of one per character.
 */
function renderInline(s, link, out) {
  let i = 0;
  let seg = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      if (i > seg) out.push(escHtml(s.slice(seg, i)));
      out.push(s[i + 1] === '>' ? '&gt;' : s[i + 1]);
      i += 2;
      seg = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > seg) out.push(escHtml(s.slice(seg, i)));
        out.push('<code>', escHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnesc(s, '**', i + 2);
        if (j > i + 2) {
          if (i > seg) out.push(escHtml(s.slice(seg, i)));
          out.push('<strong>');
          renderInline(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
          seg = i;
        } else i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > seg) out.push(escHtml(s.slice(seg, i)));
        out.push('<em>');
        renderInline(s.slice(i + 1, j), link, out);
        out.push('</em>');
        i = j + 1;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > seg) out.push(escHtml(s.slice(seg, i)));
        out.push('<a href="', escHtml(link(target)), '">');
        renderInline(s.slice(i + 1, k), link, out);
        out.push('</a>');
        i = m + 1;
        seg = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (n > seg) out.push(escHtml(s.slice(seg)));
}

/** `s` rendered inline, as one string. */
function inlineStr(s, link) {
  const out = [];
  renderInline(s, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML) and its excerpt (the first paragraph's inline HTML,
 * or ""). Blocks are rendered as they are scanned, with no token list.
 */
function renderMd(src, link, slugCache) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const kind = blockKind(line);
    if (kind === 0) {
      i++;
      continue;
    }
    if (kind === 1) {
      const lang = FENCE_OPEN.exec(line)[1];
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${lang === '' ? '' : ` class="language-${escHtml(lang)}"`}>`);
      for (const l of body) out.push(escHtml(l), '\n');
      out.push('</code></pre>\n');
      continue;
    }
    if (kind === 2) {
      const h = headingOf(line);
      const id = uniqSlug(slugify(h.text, slugCache), ids);
      if (h.depth === 2 || h.depth === 3) {
        const html = inlineStr(h.text, link);
        out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
        toc.push({ level: h.depth, id, html });
      } else {
        out.push(`<h${h.depth} id="${id}">`);
        renderInline(h.text, link, out);
        out.push(`</h${h.depth}>\n`);
      }
      i++;
      continue;
    }
    if (kind === 3) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (kind === 4) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const qlines = body.map(trimLine).filter((l) => l !== '');
      if (qlines.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        renderInline(qlines.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    if (kind === 5 || kind === 6) {
      const ordered = kind === 6;
      const marker = ordered ? ORDERED : BULLET;
      const items = [];
      let start = 1;
      let first = true;
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          if (first && ordered) start = Number(m[1]);
          first = false;
          items.push([trimLine(ordered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      out.push(`${open}\n`);
      for (const it of items) {
        out.push('<li>');
        renderInline(it.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, link);
      excerpt = html;
      out.push(`<p>${html}</p>\n`);
    } else {
      out.push('<p>');
      renderInline(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

/* -------------------------------------------------------------- templates */

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INC = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TplErr extends Error {}

/** The path `text` names, split at its dots, or a TplErr. */
function tplPath(name, text) {
  if (!TPL_PATH.test(text)) throw new TplErr(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTpl(name, src) {
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
      if (close === -1) throw new TplErr(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPath(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TplErr(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TplErr when it does not parse). */
function parseTpl(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTpl(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TplErr(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TplErr(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INC.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TplErr(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TplErr(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The template helpers a compiled template calls: esc (escape), txt (a value
 * as text), tru (an if's truth), lk (a name in the scope chain: the nearest
 * frame holding it, the caller's loop frames included), inc (an include, by
 * name, in the same scope).
 */
const tplHelpers = {
  esc: escHtml,
  txt: textOf,
  tru: truthy,
  lk(S, name) {
    let s = S;
    while (s !== null) {
      if (Object.hasOwn(s.v, name)) return s.v[name];
      s = s.p;
    }
    return undefined;
  },
  inc(T, name, S, O, D, H, R) {
    const f = T.get(name);
    if (f !== undefined && D < INCLUDE_DEPTH) f(S, O, D + 1, H, T, R);
  },
};

/**
 * Compile a parsed template into a function (S, O, D, H, T, R): S the scope
 * frame {v, p}, O the output array, D the include depth, H the helpers, T
 * the compiled templates by name, R the top-level values. A path's first
 * name is read from the innermost loop that binds it (a frame variable) or
 * from R (guarded, so a name R does not hold reads as undefined, never as a
 * property of Object.prototype); each next name is an own property of the
 * value so far, or the path is undefined.
 */
function compileTpl(nodes) {
  const code = [];
  let tmpCount = 0;
  let frameCount = 0;
  const scopes = [];
  let scopeVar = 'S';

  /** The expression for the value of first name `name` in the current scope. */
  function firstName(name) {
    for (let d = scopes.length - 1; d >= 0; d--) {
      const hit = scopes[d].get(name);
      if (hit !== undefined) return hit;
    }
    // Not bound by a loop of this template: it may live in a caller's frame
    // (an include renders in the caller's scope) or in the top-level values,
    // so walk the chain at runtime instead of reading R alone.
    return `H.lk(${scopeVar}, '${name}')`;
  }

  /** Emit a lookup of `path` into a fresh temp; return the temp's name. */
  function emitLookup(path) {
    const t = `_t${tmpCount++}`;
    code.push(`let ${t} = ${firstName(path[0])};`);
    for (let k = 1; k < path.length; k++) {
      const seg = path[k];
      code.push(`if (${t} !== null && typeof ${t} === 'object' && Object.hasOwn(${t}, '${seg}')) ${t} = ${t}['${seg}']; else ${t} = undefined;`);
    }
    return t;
  }

  function emitNodes(list) {
    for (const n of list) {
      if (n.kind === 'text') {
        code.push(`O.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var') {
        const t = emitLookup(n.path);
        code.push(`O.push(H.esc(H.txt(${t})));`);
      } else if (n.kind === 'raw') {
        const t = emitLookup(n.path);
        code.push(`O.push(H.txt(${t}));`);
      } else if (n.kind === 'if') {
        const t = emitLookup(n.path);
        code.push(`if (H.tru(${t}) !== ${n.not}) {`);
        emitNodes(n.then);
        if (n.else !== null) {
          code.push('} else {');
          emitNodes(n.else);
        }
        code.push('}');
      } else if (n.kind === 'for') {
        const t = emitLookup(n.path);
        const xs = `_x${tmpCount++}`;
        const k = `_k${tmpCount++}`;
        code.push(`const ${xs} = ${t};`);
        code.push(`if (Array.isArray(${xs})) {`);
        code.push(`for (let ${k} = 0; ${k} < ${xs}.length; ${k}++) {`);
        const fv = `F${frameCount++}`;
        code.push(`const ${fv} = {v: {${n.name}: ${xs}[${k}], loop: {index: ${k} + 1, first: ${k} === 0, last: ${k} === ${xs}.length - 1, length: ${xs}.length}}, p: ${scopeVar}};`);
        const m = new Map();
        m.set(n.name, `${fv}.v.${n.name}`);
        m.set('loop', `${fv}.v.loop`);
        scopes.push(m);
        const saved = scopeVar;
        scopeVar = fv;
        emitNodes(n.body);
        scopeVar = saved;
        scopes.pop();
        code.push('}');
        code.push('}');
      } else if (n.kind === 'include') {
        code.push(`H.inc(T, ${JSON.stringify(n.name)}, ${scopeVar}, O, D, H, R);`);
      }
    }
  }

  emitNodes(nodes);
  return new Function('S', 'O', 'D', 'H', 'T', 'R', code.join('\n'));
}

/* ------------------------------------------------------------------ build */

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. Every call builds its own state. */
function buildSite(input) {
  const slugCache = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const reportLines = [];

  // Templates, parsed and compiled in code-unit order of their name. One
  // that does not parse is reported and left out, as if it were not there.
  const compiled = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      compiled.set(name, compileTpl(parseTpl(name, input.templates[name])));
    } catch (err) {
      if (err instanceof TplErr) reportLines.push(err.message);
      else throw err;
    }
  }

  // Sources, in code-unit order of their paths; a source that is not .md is static.
  const files = [...input.files].sort((a, b) => byCodeUnits(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter and the checks, in order: refused, a generator-owned
  // directory, a post with no date, a layout that is no template, a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFm(s.text);
    if ('error' in fm) {
      reportLines.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.isPost = s.path.startsWith('posts/');
    let ownDir = null;
    for (const d of ['tags', 'page']) {
      if (s.path.startsWith(`${d}/`)) {
        ownDir = d;
        break;
      }
    }
    if (ownDir !== null) {
      reportLines.push(`refused ${s.path}: ${ownDir}/ is the generator's own`);
      continue;
    }
    if (s.isPost && !Object.hasOwn(s.data, 'date')) {
      reportLines.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.isPost ? 'post' : 'page');
    if (!compiled.has(layout)) {
      reportLines.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      reportLines.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, unique in its directory, in source order.
  const takenByDir = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.isPost ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? ['posts', 'tags', 'page'] : []);
      takenByDir.set(dir, taken);
    }
    const slug = uniqSlug(s.data.slug ?? slugify(s.data.title, slugCache), taken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolveRel(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMd(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }

  // Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.isPost);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, named as first met in the posts' order.
  const ownTagPairs = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push([name, slug]);
      }
    }
    return out;
  };
  const tagBySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const [name, slug] of ownTagPairs(p)) {
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.isPost) continue;
    s.tagRefs = ownTagPairs(s).map(([name, slug]) => tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...tagBySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // What templates see: cards, pages, the site, its tags and its recent posts.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(cards.get(s) ?? cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.isPost,
  });

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const rootVars = { site, tags: allTags, recent, ...vars };
    const out = [];
    fn({ v: rootVars, p: null }, out, 0, tplHelpers, compiled, rootVars);
    return out.join('');
  };

  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) reportLines.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...reportLines, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.isPost).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return buildSite(input);
}
