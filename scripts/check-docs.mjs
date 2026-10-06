/** Offline documentation contract check. Never fetches links or rewrites files. */
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { marked } from 'marked';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LIMIT = 8 * 1024;
const LOCAL_LIMIT = 4 * 1024;
const CHAIN_LIMIT = 24 * 1024;
const slash = (p) => p.split(sep).join('/');

function walk(root, directory, accept) {
  const start = join(root, directory);
  if (!existsSync(start)) return [];
  const files = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, path, accept));
    else if (accept(path)) files.push(slash(path));
  }
  return files;
}

function activeFiles(root) {
  // Root untracked operator notes and unrelated review directories are not inputs.
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch { /* Temporary self-test fixture need not be a Git repository. */ }
  const knownRoot = ['AGENTS.md', 'README.md'];
  const movedPath = join(root, 'docs/document-moves.json');
  if (existsSync(movedPath)) knownRoot.push(...Object.keys(JSON.parse(readFileSync(movedPath, 'utf8'))));
  const nested = ['src', 'scripts', 'docs'].flatMap((dir) => walk(root, dir, (p) => p.endsWith('.md')));
  return [...new Set([...tracked, ...knownRoot, ...nested])]
    .filter((p) => existsSync(join(root, p)) && !p.startsWith('docs/archive/') && !/(^|\/)(test-fixtures|fixtures|__fixtures__)(\/|$)/.test(p)).sort();
}

function hrefs(markdown) {
  const tokens = marked.lexer(markdown);
  const found = [];
  // marked distinguishes code, inline code and literal examples from actual links.
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if ((value.type === 'link' || value.type === 'image') && typeof value.href === 'string') found.push(value.href);
    for (const [key, child] of Object.entries(value)) if (key !== 'links') visit(child);
  }
  visit(tokens);
  return found;
}

function localTarget(root, file, href) {
  if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  const pathname = href.split(/[?#]/, 1)[0];
  if (!pathname) return null;
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { throw new Error(`invalid URL encoding: ${href}`); }
  return resolve(dirname(join(root, file)), decoded);
}

function headings(markdown) {
  return marked.lexer(markdown).filter((t) => t.type === 'heading' && t.depth >= 2 && t.depth <= 4)
    .map((t) => ({ level: t.depth, title: t.text }));
}

export function checkDocs(root = DEFAULT_ROOT) {
  const errors = [];
  const files = activeFiles(root);
  const instructions = files.filter((p) => basename(p) === 'AGENTS.md');
  let maxChain = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    for (const href of hrefs(text)) {
      try {
        const target = localTarget(root, file, href);
        if (target && !existsSync(target)) errors.push(`${file}: missing local target ${href}`);
      } catch (e) { errors.push(`${file}: ${e.message}`); }
    }
    if (file.startsWith('docs/') || file.startsWith('src/') || file === 'scripts/README.md' || file.startsWith('scripts/docs/')) {
      if (basename(file) !== 'AGENTS.md') {
        if (!/^Status:\s*\S.+$/m.test(text)) errors.push(`${file}: missing Status metadata`);
        if (!/^Owner:\s*\S.+$/m.test(text)) errors.push(`${file}: missing Owner metadata`);
      }
    }
  }
  for (const file of instructions) {
    const bytes = statSync(join(root, file)).size;
    const limit = file === 'AGENTS.md' ? ROOT_LIMIT : LOCAL_LIMIT;
    if (bytes > limit) errors.push(`${file}: ${bytes} bytes exceeds ${limit}-byte instruction budget`);
    const parent = dirname(file);
    const ancestors = instructions.filter((p) => {
      const ancestor = dirname(p);
      return ancestor === '.' || ancestor === parent || parent.startsWith(ancestor + '/');
    });
    const total = ancestors.reduce((sum, p) => sum + statSync(join(root, p)).size, 0);
    maxChain = Math.max(maxChain, total);
    if (total > CHAIN_LIMIT) errors.push(`${file}: ${total}-byte ancestor chain exceeds ${CHAIN_LIMIT}`);
  }
  const movesPath = join(root, 'docs/document-moves.json');
  if (existsSync(movesPath)) {
    const moves = JSON.parse(readFileSync(movesPath, 'utf8'));
    for (const [source, destinations] of Object.entries(moves)) {
      if (!existsSync(join(root, source))) { errors.push(`missing compatibility pointer ${source}`); continue; }
      const text = readFileSync(join(root, source), 'utf8');
      if (!text.includes('This document moved.')) errors.push(`${source}: not a compatibility pointer`);
      if (Buffer.byteLength(text) > 2048) errors.push(`${source}: pointer exceeds 2 KiB`);
      const targets = new Set(hrefs(text).map((href) => localTarget(root, source, href)).filter(Boolean));
      for (const dest of destinations) {
        if (!existsSync(join(root, dest))) errors.push(`${source}: moved destination missing ${dest}`);
        if (!targets.has(resolve(root, dest))) errors.push(`${source}: missing canonical pointer to ${dest}`);
      }
    }
  }
  const mapPath = join(root, 'docs/agent-context-migration.json');
  if (existsSync(mapPath)) {
    const map = JSON.parse(readFileSync(mapPath, 'utf8'));
    const source = join(root, map.source);
    if (!existsSync(source)) errors.push('migration source missing');
    else {
      const text = readFileSync(source);
      if (createHash('sha256').update(text).digest('hex') !== map.sourceSha256) errors.push('migration archive checksum changed');
      const expected = headings(text.toString());
      const mapped = map.sections.map(({ level, title }) => ({ level, title }));
      if (JSON.stringify(expected) !== JSON.stringify(mapped)) errors.push('migration heading coverage differs from original guide');
      for (const section of map.sections) {
        if (!section.current?.length || !section.instructions?.length) errors.push(`unowned archived section: ${section.title}`);
        for (const p of [...(section.current ?? []), ...(section.instructions ?? [])]) {
          if (!existsSync(join(root, p))) errors.push(`migration owner target missing: ${p}`);
        }
      }
    }
    const archive = dirname(source);
    const manifest = join(archive, 'originals.json');
    if (existsSync(manifest)) for (const [name, hash] of Object.entries(JSON.parse(readFileSync(manifest, 'utf8')))) {
      const p = join(archive, name);
      if (!existsSync(p) || createHash('sha256').update(readFileSync(p)).digest('hex') !== hash) errors.push(`original archive changed: ${name}`);
    }
  }
  return { errors, files: files.length, instructions: instructions.length, maxChain };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'atomic-doc-check-'));
  let cases = 0;
  const put = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
  const expect = (fragment) => {
    const errors = checkDocs(root).errors;
    if (!errors.some((e) => e.includes(fragment))) throw new Error(`self-test expected ${fragment}; got ${errors.join('; ')}`);
    cases++;
  };
  try {
    put('AGENTS.md', '# Instructions\n');
    put('README.md', '[ok](src/feature/README.md)\n');
    put('src/feature/README.md', '# Feature\n\nStatus: current\nOwner: src/feature/\n');
    if (checkDocs(root).errors.length) throw new Error('valid fixture failed'); cases++;
    put('src/feature/AGENTS.md', 'x'.repeat(LOCAL_LIMIT + 1)); expect('instruction budget');
    put('src/feature/AGENTS.md', '# Local\n');
    put('AGENTS.md', 'x'.repeat(ROOT_LIMIT + 1)); expect('instruction budget');
    put('AGENTS.md', 'x'.repeat(ROOT_LIMIT));
    for (let i = 1; i <= 5; i++) put('src/' + Array(i).fill('nested').join('/') + '/AGENTS.md', 'x'.repeat(LOCAL_LIMIT));
    expect('ancestor chain'); rmSync(join(root, 'src/nested'), { recursive: true });
    put('AGENTS.md', '# Instructions\n');
    put('README.md', '[missing](not-here.md)\n'); expect('missing local target');
    put('README.md', '[web](https://example.invalid/)\n````\n[example](missing.md)\n````\n`[inline](missing.md)`\n');
    if (checkDocs(root).errors.length) throw new Error('external/code fixture failed'); cases++;
    put('src/feature/README.md', '# Feature\n'); expect('missing Status'); expect('missing Owner');
    put('src/feature/README.md', '# Feature\nStatus: current\nOwner: src/feature/\n');
    put('docs/archive/legacy.md', '[old broken link](missing.md)\n');
    if (checkDocs(root).errors.length) throw new Error('archive exclusion failed'); cases++;
    put('docs/document-moves.json', JSON.stringify({ 'OLD.md': ['src/feature/README.md'] }));
    put('OLD.md', 'This document moved.\n'); expect('missing canonical pointer');
    put('OLD.md', 'This document moved.\n[guide](src/feature/README.md)\n');
    if (checkDocs(root).errors.length) throw new Error('valid pointer failed'); cases++;
    console.log(`docs self-test: ${cases} checks passed`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--self-test')) throw new Error('Usage: node scripts/check-docs.mjs [--self-test]');
  if (args[0] === '--self-test') selfTest();
  else {
    const result = checkDocs();
    if (result.errors.length) { for (const error of result.errors) console.error(error); process.exitCode = 1; }
    else console.log(`docs: ${result.files} active files, ${result.instructions} instruction files; maximum chain ${result.maxChain}/${CHAIN_LIMIT} bytes; links, metadata, pointers and archive coverage passed`);
  }
}
