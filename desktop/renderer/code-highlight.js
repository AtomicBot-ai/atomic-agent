/* ---------------- ATO-1025: colour in a reply's code blocks ----------------
   Loaded before renderer.js; declares only. Shared by the renderer and the
   Node checks (test/code-highlight.test.mjs).

   A fenced block was grey monospace on grey. highlightCode(escaped, lang)
   takes the block's text as renderProse holds it (already HTML-escaped) and
   wraps comments, strings, keywords and numbers in spans that chat.css
   colours from the theme's own tokens. No library, no network: one small
   tokenizer per language family, and a block it does not know (or one too
   big to be worth it) comes back exactly as it went in. */

const HL_MAX = 20000;
const HL_KW = {
  c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr class public private protected virtual template typename namespace using new delete this throw try catch',
  js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield interface type enum implements readonly as keyof declare abstract',
  py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self match case',
  sh: 'if then else elif fi for while until do done case esac in function return local export readonly unset echo exit cd source set shift true false sudo',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil',
  rs: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while None Some Ok Err',
  sql: 'select from where and or not insert into values update set delete create table drop alter index join left right inner outer on group by order having limit offset as distinct union all null is in like between case when then else end primary key foreign references default',
  rb: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require',
};
/* Fence names a model writes → [keyword set, comment style, extra string forms]. */
const HL_LANG = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', mjs: 'js', cjs: 'js', json: 'json',
  java: 'c', c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', cs: 'c', csharp: 'c', 'c#': 'c', kotlin: 'c', kt: 'c', swift: 'c', php: 'c', dart: 'c', scala: 'c',
  py: 'py', python: 'py', python3: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', shell: 'sh', console: 'sh', ps1: 'sh', powershell: 'sh', dockerfile: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml',
  go: 'go', golang: 'go', rs: 'rs', rust: 'rs', sql: 'sql', rb: 'rb', ruby: 'rb',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', less: 'css',
};

function hlUnescape(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}
function hlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* One regex per family; group 1 comment, 2 string, 3 number, 4 word. */
const HL_RE = {};
function hlRegex(fam) {
  if (HL_RE[fam]) return HL_RE[fam];
  const hash = /^(py|sh|yaml|rb)$/.test(fam);
  const comment = fam === 'html' ? '<!--[\\s\\S]*?-->'
    : fam === 'sql' ? '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'
    : fam === 'css' ? '\\/\\*[\\s\\S]*?\\*\\/'
    : fam === 'json' ? '(?!)'
    : hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/';
  const triple = fam === 'py' ? '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' : '';
  const tick = fam === 'js' || fam === 'go' || fam === 'sh' ? '|`(?:\\\\[\\s\\S]|[^`\\\\])*`' : '';
  const single = fam === 'rs' ? '' : '|\'(?:\\\\.|[^\'\\\\\\n])*\'';
  const string = triple + '"(?:\\\\.|[^"\\\\\\n])*"' + single + tick;
  const number = '\\b(?:0x[\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b';
  HL_RE[fam] = new RegExp('(' + comment + ')|(' + string + ')|(' + number + ')|([A-Za-z_$][\\w$]*)', fam === 'sql' ? 'gi' : 'g');
  return HL_RE[fam];
}
const HL_SETS = {};
function hlKeywords(fam) {
  if (HL_SETS[fam]) return HL_SETS[fam];
  const words = fam === 'json' ? 'true false null' : fam === 'yaml' ? 'true false null yes no on off' : (HL_KW[fam] || '');
  HL_SETS[fam] = new Set(words.split(' ').filter(Boolean));
  return HL_SETS[fam];
}

function highlightCode(escaped, lang) {
  const fam = HL_LANG[String(lang || '').toLowerCase()];
  if (!fam || !escaped || escaped.length > HL_MAX) return escaped;
  const raw = hlUnescape(escaped);
  const re = hlRegex(fam), kw = hlKeywords(fam);
  const fold = fam === 'sql';
  let out = '', at = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(raw))) {
    if (!m[0]) { re.lastIndex++; continue; }
    let cls = m[1] ? 'hl-c' : m[2] ? 'hl-s' : m[3] ? 'hl-n' : kw.has(fold ? m[4].toLowerCase() : m[4]) ? 'hl-k' : '';
    // A JSON key is a string followed by a colon: it reads as a name, not a value.
    if (cls === 'hl-s' && fam === 'json' && /^\s*:/.test(raw.slice(re.lastIndex))) cls = 'hl-p';
    if (!cls) continue;
    out += hlEscape(raw.slice(at, m.index)) + '<span class="' + cls + '">' + hlEscape(m[0]) + '</span>';
    at = re.lastIndex;
  }
  return out + hlEscape(raw.slice(at));
}

if (typeof module !== 'undefined') module.exports = {highlightCode, HL_LANG};
