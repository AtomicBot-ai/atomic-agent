/**
 * soak.mjs: leave the real app working for hours and see what wears out.
 *
 * Real window, real `atag serve`, real tools, real clicks; the model is the
 * scripted one, with a delay, so no GPU and no key. See README.md here for how
 * to run it and how to read the result.
 *
 * It is one long `liveScenario` body. The harness puts no time limit on a body
 * (only each CDP call has 30 s and each `waitTurn` its own `timeout`), so the
 * limits that matter are the ones set below. The harness keeps some things
 * for the whole run that a normal scenario never notices; `trimBuffers` keeps
 * those from turning into a leak in this process.
 */

import { execFile, execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { EXIT_NOT_READY, Failure, ask, sleep, waitTurn } from '../harness.mjs';
import { liveScenario } from '../live/live-harness.mjs';
import { call, reply } from '../live/scripted-model.mjs';

/* ----------------------------------------------------------- thresholds --
   First guesses. None of these comes from a measurement: tune them after the
   first real night, from its CSV. */
const WARMUP_MINUTES = 30;              // memory before this is not judged
const MIN_JUDGED_MINUTES = 60;          // less than this after warm-up: too little to fit a slope
const MAX_SLOPE_MB_PER_HOUR = { main: 15, renderer: 40, serve: 25 };
const TURN_HANG_LIMIT_MS = 180000;      // a turn running longer than this has hung
const MAX_LATENCY_FACTOR = 2;           // late median over early median
const LATENCY_SKIP_TURNS = 5;           // cold-start turns left out of the early median
const LATENCY_WINDOW_TURNS = 30;        // turns in the early and in the late median

/* ------------------------------------------------------------ the workload */
const SAMPLE_EVERY_MS = 60000;
const STATUS_EVERY_MS = 15 * 60000;
const STEP_DELAY_MS = 1500;             // how long the scripted model takes per answer
const TURN_PAUSE_MS = 4000;             // a person reading, between turns
const QUIET_MS = 1200;                  // how long waitTurn wants the window to stay idle
const NEW_CHAT_EVERY = 29;              // turns
const SWITCH_EVERY = 7;                 // turns
const STOP_EVERY = 13;                  // turns
const KEEP_SIDE_CHATS = 5;              // switch targets; older ones sink down the list
const KEEP_MODEL_REQUESTS = 16;
const KEEP_APP_CHUNKS = 2000;
const STOP_WAIT_MS = 20000;
const SWITCH_WAIT_MS = 30000;

const HOURS = Number(process.env.ATAG_SOAK_HOURS || 6);
if (!(HOURS > 0)) {
  console.error(`ATAG_SOAK_HOURS must be a positive number, got ${process.env.ATAG_SOAK_HOURS}`);
  process.exit(2);
}
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = process.env.ATAG_SOAK_OUT || join(tmpdir(), 'atag-soak');
const SAMPLES_CSV = join(OUT_DIR, `soak-${STAMP}-samples.csv`);
const TURNS_CSV = join(OUT_DIR, `soak-${STAMP}-turns.csv`);
const VERDICT_TXT = join(OUT_DIR, `soak-${STAMP}-verdict.txt`);

const SAMPLE_COLUMNS = ['time', 'minute', 'main_pid', 'main_rss_mb', 'renderer_pid', 'renderer_rss_mb', 'renderer_count',
  'serve_pid', 'serve_rss_mb', 'main_open_files', 'renderer_open_files', 'serve_open_files',
  'turns', 'stops', 'chats', 'latency_median_ms', 'latency_max_ms', 'event'];
const TURN_COLUMNS = ['time', 'minute', 'n', 'kind', 'chat', 'ms'];
/* Only these count toward the latency verdict: a Stop or a switch is not a turn. */
const TURN_KINDS = new Set(['read', 'write', 'shell', 'plain']);

const pexec = promisify(execFile);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => (x === null || x === undefined ? '' : Math.round(x * 10) / 10);
const csvCell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/* ---------------------------------------------------------------- state -- */
const state = {
  base: null,
  startedAt: null,
  closing: false,
  fatal: null,
  samples: [],
  turns: [],
  stops: 0,
  chats: 1,
  sinceSample: [],
  baseline: { rendererPid: null, servePid: null },
};
let rejectFatal;
const fatalSignal = new Promise((_, rej) => { rejectFatal = rej; });
fatalSignal.catch(() => {}); // nothing may be racing it at the moment it fires

/** The first thing to go wrong ends the run and is what the verdict names. */
function fatal(kind, detail) {
  if (state.fatal || state.closing) return;
  state.fatal = { kind, detail };
  console.log(`\n[soak] ${kind}: ${detail}`);
  rejectFatal(new Failure(`${kind}: ${detail}`));
}

const minutes = () => (state.startedAt === null ? 0 : (Date.now() - state.startedAt) / 60000);

function appendRow(file, columns, row) {
  appendFileSync(file, `${columns.map((c) => csvCell(row[c])).join(',')}\n`);
}

function recordTurn(n, kind, chat, ms) {
  const row = { time: new Date().toISOString(), minute: round1(minutes()), n, kind, chat, ms: Math.round(ms) };
  state.turns.push(row);
  if (TURN_KINDS.has(kind)) state.sinceSample.push(ms);
  appendRow(TURNS_CSV, TURN_COLUMNS, row);
}

/* ------------------------------------------------------------- sampling -- */
/** Parse `ps`, then find this run's processes by its throwaway path and by
    being children of its Electron main process. */
async function findProcesses(base) {
  const { stdout } = await pexec('ps', ['-axww', '-o', 'pid=,ppid=,rss=,command='],
    { maxBuffer: 64 * 1024 * 1024, timeout: 20000 });
  const all = stdout.split('\n')
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), rssMb: Number(m[3]) / 1024, command: m[4] }))
    .filter((p) => p.pid !== process.pid);
  const carrying = all.filter((p) => p.command.includes(base));
  /* The Electron binary itself, not the `.bin/electron` node shim that also
     carries the path, and not a helper. */
  const main = carrying.find((p) => /(MacOS\/Electron|dist\/electron)\s/.test(p.command) && !p.command.includes('--type=')) ?? null;
  const family = new Set(main ? [main.pid] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (family.has(p.ppid) && !family.has(p.pid)) { family.add(p.pid); grew = true; }
  }
  const related = all.filter((p) => family.has(p.pid) || p.command.includes(base));
  const renderers = related.filter((p) => p.command.includes('--type=renderer')).sort((a, b) => b.rssMb - a.rssMb);
  const serve = related.find((p) => /dist\/cli\/index\.js"?\s+serve\b/.test(p.command)) ?? null;
  return { main, renderers, serve };
}

/** Open files per pid. lsof exits non-zero if one pid has just gone, and
    still prints the rest. */
async function openFiles(pids) {
  const list = pids.filter(Boolean);
  if (!list.length) return new Map();
  let out = '';
  try {
    ({ stdout: out } = await pexec('lsof', ['-n', '-P', '-w', '-Ff', '-p', list.join(',')],
      { maxBuffer: 64 * 1024 * 1024, timeout: 30000 }));
  } catch (e) { out = e.stdout ?? ''; }
  const counts = new Map();
  let pid = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)); counts.set(pid, 0); }
    else if (line[0] === 'f' && pid !== null) counts.set(pid, counts.get(pid) + 1);
  }
  return counts;
}

async function takeSample(event = '') {
  const { main, renderers, serve } = await findProcesses(state.base);
  const top = renderers[0] ?? null;
  const fds = await openFiles([main?.pid, top?.pid, serve?.pid]);
  /* The run may have ended while `ps` and `lsof` were out. */
  if (state.closing && !event) return;
  const latencies = state.sinceSample;
  state.sinceSample = [];
  const row = {
    time: new Date().toISOString(), minute: round1(minutes()),
    main_pid: main?.pid, main_rss_mb: round1(main?.rssMb),
    renderer_pid: top?.pid, renderer_rss_mb: round1(top?.rssMb), renderer_count: renderers.length,
    serve_pid: serve?.pid, serve_rss_mb: round1(serve?.rssMb),
    main_open_files: fds.get(main?.pid), renderer_open_files: fds.get(top?.pid), serve_open_files: fds.get(serve?.pid),
    turns: state.turns.filter((t) => TURN_KINDS.has(t.kind)).length, stops: state.stops, chats: state.chats,
    latency_median_ms: latencies.length ? Math.round(median(latencies)) : null,
    latency_max_ms: latencies.length ? Math.round(Math.max(...latencies)) : null,
    event,
  };
  state.samples.push(row);
  appendRow(SAMPLES_CSV, SAMPLE_COLUMNS, row);

  state.baseline.rendererPid ??= top?.pid ?? null;
  state.baseline.servePid ??= serve?.pid ?? null;
  if (!main) fatal('app crash', 'the Electron main process is gone');
  else if (state.baseline.rendererPid && !renderers.some((p) => p.pid === state.baseline.rendererPid)) {
    fatal('app crash', `the window's renderer process ${state.baseline.rendererPid} is gone`);
  } else if (!serve) fatal('agent crash', '`atag serve` is gone');
  else if (state.baseline.servePid && serve.pid !== state.baseline.servePid) {
    fatal('agent crash', `\`atag serve\` was replaced: pid ${state.baseline.servePid} became ${serve.pid}`);
  }
}

/* -------------------------------------------------------------- verdict -- */
/** Least-squares slope, in MB per hour, of (minute, value) pairs. */
function slopePerHour(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  const den = points.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  return den ? (points.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / den) * 60 : 0;
}

/** Everything the verdict needs is in memory and this is synchronous, so a
    signal handler can call it. */
function report(ended, result) {
  const problems = [];
  const lines = [];
  if (state.fatal) problems.push(`${state.fatal.kind}: ${state.fatal.detail}`);
  else if (result && !result.ok) problems.push(`the run failed: ${result.error}`);

  const latencies = state.turns.filter((t) => TURN_KINDS.has(t.kind)).map((t) => t.ms);
  if (latencies.length >= LATENCY_SKIP_TURNS + 2 * LATENCY_WINDOW_TURNS) {
    const early = median(latencies.slice(LATENCY_SKIP_TURNS, LATENCY_SKIP_TURNS + LATENCY_WINDOW_TURNS));
    const late = median(latencies.slice(-LATENCY_WINDOW_TURNS));
    const factor = late / early;
    lines.push(`turn latency: median ${(early / 1000).toFixed(1)}s early, ${(late / 1000).toFixed(1)}s late, x${factor.toFixed(2)} (limit x${MAX_LATENCY_FACTOR})`);
    if (factor > MAX_LATENCY_FACTOR) problems.push(`turns got slower: x${factor.toFixed(2)}, limit x${MAX_LATENCY_FACTOR}`);
  } else {
    lines.push(`turn latency: not judged, only ${latencies.length} turns`);
  }

  for (const [label, key] of [['main', 'main_rss_mb'], ['renderer', 'renderer_rss_mb'], ['serve', 'serve_rss_mb']]) {
    const points = state.samples.filter((s) => s.minute >= WARMUP_MINUTES && typeof s[key] === 'number')
      .map((s) => ({ x: s.minute, y: s[key] }));
    const span = points.length ? points[points.length - 1].x - points[0].x : 0;
    if (span < MIN_JUDGED_MINUTES) {
      lines.push(`memory ${label}: not judged, ${Math.round(span)} minutes after warm-up (needs ${MIN_JUDGED_MINUTES})`);
      continue;
    }
    const slope = slopePerHour(points);
    const limit = MAX_SLOPE_MB_PER_HOUR[label];
    lines.push(`memory ${label}: ${points[0].y} MB to ${points[points.length - 1].y} MB, ${slope.toFixed(1)} MB/hour (limit ${limit})`);
    if (slope > limit) problems.push(`${label} memory grows ${slope.toFixed(1)} MB/hour, limit ${limit}`);
  }

  /* Reported, not judged: a sample of open files only means something next
     to the first night's numbers. */
  const firstFull = state.samples.find((s) => s.main_open_files !== undefined);
  const last = state.samples[state.samples.length - 1];
  if (firstFull && last) {
    lines.push(`open files, start to end: main ${firstFull.main_open_files} to ${last.main_open_files}, `
      + `renderer ${firstFull.renderer_open_files} to ${last.renderer_open_files}, serve ${firstFull.serve_open_files} to ${last.serve_open_files}`);
  }

  const ok = problems.length === 0;
  const text = [
    '',
    `SOAK VERDICT: ${ok ? 'PASS' : 'FAIL'}`,
    `ran ${(minutes() / 60).toFixed(2)} of ${HOURS} hours (${ended}); `
      + `${latencies.length} turns, ${state.stops} stopped mid-turn, ${state.chats} chats`,
    ...problems.map((p) => `FAILED: ${p}`),
    ...lines,
    `samples: ${SAMPLES_CSV}`,
    `turns: ${TURNS_CSV}`,
    ...(state.base ? [`run directory: ${state.base}`] : []),
    '',
  ].join('\n');
  console.log(text);
  try { writeFileSync(VERDICT_TXT, text); } catch { /* the console has it */ }
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------- the turns -- */
/**
 * drive.mjs and the harness both keep things for the life of the app:
 * every model request body, every line the app printed, every click narrated.
 * Over a night that is real memory in this process, and in a soak that would
 * be a leak of our own making. Only the tail is used for evidence.
 */
function trimBuffers(app, model) {
  for (const list of [model.requests, model.other]) {
    if (list.length > KEEP_MODEL_REQUESTS) list.splice(0, list.length - KEEP_MODEL_REQUESTS);
  }
  if (app._out.length > KEEP_APP_CHUNKS) app._out.splice(0, app._out.length - KEEP_APP_CHUNKS);
  app.transcript.length = 0;
}

const slow = (step) => ({ ...step, delay: STEP_DELAY_MS });

/** A fixed rotation, so the early and the late window are the same mix. */
function turnPlan(n, token) {
  const file = `note-${n % 5}.txt`;
  const content = `soak note ${n}\n`;
  const kinds = [
    { kind: 'read', steps: [call('os.fs.read', { path: 'seed.txt' })] },
    { kind: 'write', steps: [call('os.fs.write', { path: file, content, mode: 'replace' })], file, content },
    { kind: 'shell', steps: [call('os.shell.run', { cmd: 'ls', args: ['-1'] })] },
    { kind: 'plain', steps: [] },
  ];
  const plan = kinds[n % kinds.length];
  return { ...plan, steps: [...plan.steps, reply(`Done with ${token}.`)].map(slow) };
}

/** The id of the chat on screen, once the agent has stored it. */
async function activeChat(app) {
  return app.waitFor(`(() => {
    const id = (document.querySelector('#sidebar .sesrow.on') || { dataset: {} }).dataset.ses || '';
    return id && !id.startsWith('waiting-') ? id : '';
  })()`, 'the open chat on the list', { timeout: SWITCH_WAIT_MS, quiet: true });
}

async function newChat(app) {
  const t0 = Date.now();
  await app.clickSel('#sidebar .sb-new[data-act="session:new"]');
  await app.waitFor(`document.querySelectorAll('#content .turn').length === 0 && !document.querySelector('.sendbtn[disabled]')`,
    'an empty new chat', { timeout: SWITCH_WAIT_MS, quiet: true });
  return Date.now() - t0;
}

async function openChat(app, chat) {
  const t0 = Date.now();
  await app.clickSel(`#sidebar .sesrow[data-ses=${JSON.stringify(chat.id)}]`);
  /* Only the newest reply is asserted: a long chat draws only its tail. */
  await app.waitFor(`(() => {
    const on = (document.querySelector('#sidebar .sesrow.on') || { dataset: {} }).dataset.ses;
    const rows = [...document.querySelectorAll('#content .turn')].filter((n) => !n.classList.contains('usr') && n.querySelector('.prose'));
    const last = rows.length ? rows[rows.length - 1].querySelector('.prose').innerText : '';
    return on === ${JSON.stringify(chat.id)} && last.includes(${JSON.stringify(chat.lastToken)})
      && !document.querySelector('.sendbtn[disabled]');
  })()`, `chat ${chat.id} with its own last reply`, { timeout: SWITCH_WAIT_MS, quiet: true });
  return Date.now() - t0;
}

async function runTurn(app, model, workspace, n, chat) {
  const token = `soak-${n}-ok`;
  const plan = turnPlan(n, token);
  model.script(plan.steps);
  const t0 = Date.now();
  await ask(app, `Turn ${n}: please carry on with the notes.`);
  const done = await waitTurn(app, { timeout: TURN_HANG_LIMIT_MS, quiet: QUIET_MS, approve: 'auto' });
  const ms = Date.now() - t0 - QUIET_MS;
  if (!done.reply.includes(token)) {
    throw new Failure(`turn ${n} ended without its reply on screen: ${JSON.stringify(done.reply.slice(0, 200))}`);
  }
  if (model.pending) throw new Failure(`turn ${n} left ${model.pending} scripted step(s) unasked`);
  if (plan.file) {
    const path = join(workspace, plan.file);
    const body = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (body !== plan.content) throw new Failure(`turn ${n} did not write ${plan.file}: ${JSON.stringify(body)}`);
  }
  chat.lastToken = token;
  recordTurn(n, plan.kind, chat.name, ms);
}

/** A turn cut off by a real click on Stop while the model is answering. */
async function runStoppedTurn(app, model, n, chat) {
  model.script([{ hold: true }]);
  const t0 = Date.now();
  await ask(app, `Turn ${n}: start something long.`);
  const until = Date.now() + STOP_WAIT_MS;
  while (!model.requests.some((r) => r.held && !r.disconnected)) {
    if (Date.now() > until) throw new Failure(`turn ${n} never reached the model`);
    await sleep(100);
  }
  await app.clickSel('.sendbtn.stop');
  /* No start grace: the window was busy already and has just gone idle. */
  await waitTurn(app, { timeout: TURN_HANG_LIMIT_MS, quiet: QUIET_MS, approve: 'none', startGrace: 0 });
  const closed = Date.now() + STOP_WAIT_MS;
  while (model.requests.some((r) => r.held && !r.disconnected)) {
    if (Date.now() > closed) fatal('hang', `Stop on turn ${n} left the request to the model open`);
    await Promise.race([sleep(100), fatalSignal]);
  }
  state.stops += 1;
  // The chat now ends with the stopped turn, and that is what reopening it must show.
  chat.lastToken = '(stopped)';
  recordTurn(n, 'stop', chat.name, Date.now() - t0 - QUIET_MS);
}

/** Turns in one long chat, with side chats started and revisited. */
async function workLoop({ app, model, workspace }) {
  const deadline = Date.now() + HOURS * 3600000;
  const long = { name: 'long', id: null, lastToken: '' };
  const sides = [];
  let open = long;
  let sideCount = 0;
  let nextSide = 0;
  let lastStatus = Date.now();

  /* Every wait below loses to a crash, so a dead app is not waited out. */
  const guarded = (p) => Promise.race([p, fatalSignal]);

  for (let n = 1; Date.now() < deadline; n += 1) {
    if (n % NEW_CHAT_EVERY === 0) {
      sideCount += 1;
      const chat = { name: `side-${sideCount}`, id: null, lastToken: '' };
      recordTurn(n, 'new', chat.name, await guarded(newChat(app)));
      await guarded(runTurn(app, model, workspace, n, chat));
      chat.id = await guarded(activeChat(app));
      state.chats += 1;
      sides.push(chat);
      if (sides.length > KEEP_SIDE_CHATS) sides.shift();
      open = chat;
    } else {
      let target = long;
      if (n % SWITCH_EVERY === 0 && sides.length) {
        target = sides[nextSide % sides.length];
        nextSide += 1;
      }
      if (target !== open) {
        recordTurn(n, 'switch', target.name, await guarded(openChat(app, target)));
        open = target;
      }
      if (n % STOP_EVERY === 0 && target === long) await guarded(runStoppedTurn(app, model, n, target));
      else await guarded(runTurn(app, model, workspace, n, target));
      if (!target.id) target.id = await guarded(activeChat(app));
    }
    trimBuffers(app, model);
    if (Date.now() - lastStatus > STATUS_EVERY_MS) {
      lastStatus = Date.now();
      const s = state.samples[state.samples.length - 1];
      console.log(`[soak] ${(minutes() / 60).toFixed(2)}h: ${state.turns.length} events, `
        + `main ${s?.main_rss_mb} MB, renderer ${s?.renderer_rss_mb} MB, serve ${s?.serve_rss_mb} MB`);
    }
    await guarded(sleep(TURN_PAUSE_MS));
  }
}

async function body({ app, model, workspace }) {
  app.verbose = false;
  state.startedAt = Date.now();
  app.proc.once('exit', (code, signal) => fatal('app crash', `Electron exited (code ${code}, signal ${signal})`));
  model.whenBroken.catch((e) => fatal('turn failed', e.message));

  let sampling = false;
  const sample = async () => {
    if (sampling || state.closing) return;
    sampling = true;
    try { await takeSample(); } catch (e) { console.log(`[soak] a sample failed: ${e.message}`); }
    sampling = false;
  };
  await sample();
  const timer = setInterval(sample, SAMPLE_EVERY_MS);

  try {
    await workLoop({ app, model, workspace });
  } catch (e) {
    const message = String(e.message);
    if (/still running after/.test(message)) fatal('hang', message);
    else if (/CDP|socket|page threw/.test(message)) fatal('app crash', `the window stopped answering: ${message}`);
    else fatal('turn failed', message);
    throw e;
  } finally {
    state.closing = true;
    clearInterval(timer);
  }
}

/* ----------------------------------------------------------------- main -- */
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SAMPLES_CSV, `${SAMPLE_COLUMNS.join(',')}\n`);
writeFileSync(TURNS_CSV, `${TURN_COLUMNS.join(',')}\n`);
console.log(`[soak] ${HOURS} hours, writing to ${OUT_DIR}`);

/* A Mac that goes to sleep overnight would read as a hung turn. */
if (process.platform === 'darwin') {
  const awake = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
  awake.on('error', () => console.log('[soak] caffeinate did not start: keep this Mac awake by hand'));
  awake.unref();
}

/* Registered before the app launches, so this runs ahead of the handler
   drive.mjs installs, which would exit before any verdict. The exit below
   still fires that file's `exit` hook, which kills the app's process group. */
let finished = false;
function onSignal(sig) {
  if (finished) return;
  finished = true;
  state.closing = true;
  const code = report(`stopped by ${sig}`, null);
  if (state.base) {
    try {
      for (const line of execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (m && m[2].includes(state.base) && Number(m[1]) !== process.pid) process.kill(Number(m[1]), 'SIGKILL');
      }
    } catch { /* what was left has gone by itself */ }
  }
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, onSignal);

const result = await liveScenario('soak', body, {
  setup: ({ base, workspace }) => {
    state.base = base;
    writeFileSync(join(workspace, 'seed.txt'), 'something to read\n'.repeat(40));
    return null;
  },
});
if (!finished) {
  finished = true;
  if (result.skipped) {
    console.log(`[soak] did not run: ${result.skipped}`);
    process.exit(EXIT_NOT_READY);
  }
  process.exit(report(state.fatal ? 'ended early' : 'time up', result));
}
