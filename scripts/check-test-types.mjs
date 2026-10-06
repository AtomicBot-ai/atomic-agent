/** Full test type coverage with an explicit, non-growing diagnostic debt ledger. */
import ts from 'typescript';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'docs/testing/test-type-debt.json';
const slash = (s) => s.split(sep).join('/');
const key = ({ path, code, message, anchor }) => JSON.stringify([path, code, message, anchor]);
const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value;

function sourceFiles(dir) {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && /\.tsx?$/.test(path)) files.push(resolve(path));
  }
  return files;
}

export function collect(root = ROOT) {
  root = resolve(root);
  const configPath = join(root, 'tsconfig.test.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  if (parsed.options.noEmit !== true) throw new Error('test typecheck must use noEmit');
  const roots = new Set(parsed.fileNames.map((p) => resolve(p)));
  const inventory = sourceFiles(join(root, 'src'));
  const omitted = inventory.filter((p) => !roots.has(p));
  if (omitted.length) throw new Error(`source files omitted from test typecheck: ${omitted.map((p) => slash(relative(root, p))).join(', ')}`);
  const normalize = (text) => text.replaceAll(root, '<root>').replaceAll(slash(root), '<root>').replaceAll('\\', '/');
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const entries = new Map();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null;
    const record = {
      path: d.file ? slash(relative(root, d.file.fileName)) : '<config>',
      code: d.code,
      message: normalize(ts.flattenDiagnosticMessageText(d.messageText, ' ')),
      anchor: d.file && d.start !== undefined ? normalize(d.file.text.slice(d.start, d.start + Math.max(d.length ?? 0, 1)).replace(/\s+/g, ' ')) : '',
      line,
      count: 1,
    };
    const fingerprint = key(record);
    const previous = entries.get(fingerprint);
    if (previous) previous.count++;
    else entries.set(fingerprint, record);
  }
  const options = { ...parsed.options };
  delete options.configFilePath;
  const normalizeOptions = (value) => typeof value === 'string' ? normalize(value)
    : Array.isArray(value) ? value.map(normalizeOptions)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeOptions(v)])) : value;
  const settings = normalizeOptions(options);
  return {
    schemaVersion: 1,
    typescript: ts.version,
    compilerOptions: stable(settings),
    rootFiles: parsed.fileNames.map((p) => slash(relative(root, p))).sort(),
    testTsx: inventory.filter((p) => p.endsWith('.test.tsx')).length,
    diagnostics: [...entries.values()].sort((a, b) => key(a).localeCompare(key(b), 'en')),
  };
}

export function compare(current, baseline) {
  const errors = [];
  if (baseline.schemaVersion !== 1) errors.push('unsupported debt schema');
  if (current.typescript !== baseline.typescript) errors.push(`TypeScript changed: ${baseline.typescript} -> ${current.typescript}; review the migration explicitly`);
  if (JSON.stringify(stable(current.compilerOptions)) !== JSON.stringify(stable(baseline.compilerOptions))) errors.push('effective compiler options changed; review the migration explicitly');
  const previous = new Map();
  for (const item of baseline.diagnostics ?? []) {
    if (!Number.isInteger(item.count) || item.count < 1 || previous.has(key(item))) throw new Error('invalid or duplicate debt entry');
    previous.set(key(item), item);
  }
  const added = [], removed = [];
  for (const item of current.diagnostics) {
    const old = previous.get(key(item));
    const difference = item.count - (old?.count ?? 0);
    if (difference > 0) added.push({ ...item, count: difference });
    if (difference < 0) removed.push({ ...old, count: -difference });
    previous.delete(key(item));
  }
  removed.push(...previous.values());
  return { errors, added, removed };
}

export function run(root = ROOT, mode = 'check') {
  const current = collect(root);
  const path = join(root, BASELINE);
  if (mode === 'capture') {
    if (existsSync(path)) throw new Error('capture refuses to overwrite existing debt; use --reduce for resolved entries');
    writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
    return { current, errors: [], added: [], removed: [], written: true };
  }
  const result = { current, ...compare(current, JSON.parse(readFileSync(path, 'utf8'))) };
  if (mode === 'reduce' && !result.errors.length && !result.added.length) {
    writeFileSync(path, JSON.stringify(current, null, 2) + '\n');
    return { ...result, removed: [], written: true };
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !['--capture', '--reduce'].includes(args[0]))) throw new Error('Usage: node scripts/check-test-types.mjs [--capture | --reduce]');
    const result = run(ROOT, args[0]?.slice(2) ?? 'check');
    for (const error of result.errors) console.error(error);
    for (const item of result.added) console.error(`NEW ${item.path}:${item.line ?? 0} TS${item.code} (x${item.count}): ${item.message}`);
    for (const item of result.removed) console.error(`RESOLVED ${item.path} TS${item.code} (x${item.count}); run typecheck:tests:reduce`);
    if (result.errors.length || result.added.length || result.removed.length) process.exitCode = 1;
    else console.log(`test types: ${result.current.rootFiles.length} roots, ${result.current.testTsx} test TSX; ${result.current.diagnostics.reduce((n, d) => n + d.count, 0)} explicit debt diagnostics; no new errors${result.written ? '; ledger written' : ''}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
