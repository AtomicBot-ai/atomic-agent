// Offline instrumentation for the paired development case study. No project code is executed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const [rootArg, logArg, action, fileArg, ...args] = process.argv.slice(2);
if (!rootArg || !logArg || !['read', 'search', 'files'].includes(action)) {
  throw new Error('Usage: node observer.mjs ROOT LOG read PATH [FIRST_LINE] [LINE_COUNT] | search PATTERN [PATH] | files [GLOB]');
}
const root = fs.realpathSync(rootArg);
const requestedLog = path.resolve(logArg);
let existing = requestedLog;
const suffix = [];
while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); existing = path.dirname(existing); }
const log = path.join(fs.realpathSync(existing), ...suffix);
if (log === root || log.startsWith(root + path.sep)) throw new Error('Observation log must be outside the task checkout');
const cap = 16384;
function checked(relative) {
  const candidate = fs.realpathSync(path.resolve(root, relative));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error('Path outside task checkout');
  return candidate;
}
let output = '', spans = [];
if (action === 'read') {
  const target = checked(fileArg);
  const bytes = fs.readFileSync(target);
  const first = Number(args[0] ?? 1), count = Number(args[1] ?? 100);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 1 || count < 1) throw new Error('Positive integer line range required');
  const starts = [0];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) starts.push(i + 1);
  const start = starts[first - 1] ?? bytes.length;
  const requestedEnd = starts[first - 1 + count] ?? bytes.length;
  const end = Math.min(requestedEnd, start + cap);
  output = bytes.subarray(start, end).toString('utf8');
  spans.push({ path: path.relative(root, target), start, end, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  if (end < requestedEnd) output += '\n[observer: excerpt capped at 16384 source bytes; request next range explicitly]\n';
} else {
  const commandArgs = action === 'files'
    ? ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!dist', ...(fileArg ? ['-g', fileArg] : [])]
    : ['-n', '--with-filename', '--no-heading', '--color', 'never', '--hidden', '-g', '!.git', '-g', '!node_modules', '-g', '!dist', '--', fileArg, args[0] ?? '.'];
  if (action === 'search') checked(args[0] ?? '.');
  const result = spawnSync('rg', commandArgs, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status > 1) throw result.error ?? new Error(result.stderr);
  const raw = Buffer.from(result.stdout);
  // Keep complete matches only; a clipped source line is not counted as fully read.
  let end = Math.min(raw.length, cap);
  if (end < raw.length) end = Math.max(0, raw.lastIndexOf(10, end));
  output = raw.subarray(0, end).toString('utf8');
  if (action === 'search') for (const line of output.split('\n')) {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    const target = checked(match[1]), bytes = fs.readFileSync(target), lineNumber = Number(match[2]);
    let start = 0;
    for (let n = 1; n < lineNumber; n++) { start = bytes.indexOf(10, start) + 1; if (!start) throw new Error('Invalid rg line'); }
    const next = bytes.indexOf(10, start);
    spans.push({ path: path.relative(root, target), start, end: next < 0 ? bytes.length : next, hash: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  if (end < raw.length) output += '\n[observer: output capped; narrow the search]\n';
}
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), action, request: [fileArg, ...args], outputBytes: Buffer.byteLength(output), output, spans }) + '\n');
process.stdout.write(output);
