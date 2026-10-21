/**
 * studio-live.drive.mjs — Studio, live, end to end: one local picture, one
 * cloud picture, one cloud clip, on a throwaway profile.
 *
 *   cd desktop && npm run build && (cd .. && npm run build)
 *   STUDIO_LIVE_OUT=/abs/out/dir ATAG_TEST_ENV=/abs/path/.env \
 *     node test/studio-live.drive.mjs
 *   (or `npm run drive:studio-live` with the same two variables)
 *
 * Optional: STUDIO_LIVE_PORT (CDP port, default 9441), STUDIO_LIVE_CLEAN=1
 * (delete the throwaway state dir, models included, at the end).
 *
 * What it does
 *   setup   a fresh state dir under $STUDIO_LIVE_OUT, the .env from
 *           $ATAG_TEST_ENV copied into it, the built app launched on it, the
 *           first-run wizard clicked through on the OpenRouter cloud route
 *           (the key from that .env, typed, never printed), and the agent up.
 *   A       Studio › Images, local: the smallest Z-Image quant in
 *           `BR.studio.catalog('image').local`, downloaded (40 min cap,
 *           progress every 30 s), then one 512×512 picture with a fixed seed
 *           (15 min cap). `gpuShare()` is read before and after. The UI does
 *           not offer an exact 512 px size for local models (it derives the
 *           size from the shape tile), so this one request goes through
 *           `BR.studio.generateImage` from the page; the page takes the job
 *           in through its job events like any job this app started.
 *   B       Studio › Images, cloud: the default OpenRouter image model,
 *           chosen with the page's own verb, the prompt typed, the price read
 *           off the Generate button, the button clicked.
 *   C       Studio › Video, cloud: the default model, 4 s, 16:9, prompt
 *           typed, Generate clicked, the player on screen at the end.
 *
 * Every step is independent: a failure is recorded with its message and a
 * screenshot, and the next step still runs. The run writes summary.json and
 * report.md into $STUDIO_LIVE_OUT (no keys in either) and exits 1 when any
 * step failed. Teardown quits the app and kills whatever is left running
 * from the throwaway state dir (Atomic Core, llama-server, sd-server),
 * matched by that path and nothing else.
 *
 * Costs real money on the OpenRouter key (one image, one 4 s clip) and
 * downloads a few GB from Hugging Face.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { launch, sleep } from './drive.mjs';
import { firstRun } from './harness.mjs';
import { assertThrowawayStateDir } from './state-guard.mjs';

/* ------------------------------------------------------------------ input -- */
const OUT_RAW = process.env.STUDIO_LIVE_OUT;
const ENV_FILE = process.env.ATAG_TEST_ENV;
const PORT = Number(process.env.STUDIO_LIVE_PORT || 9441);
const CLEAN = process.env.STUDIO_LIVE_CLEAN === '1';

if (!OUT_RAW) { console.error('STUDIO_LIVE_OUT must name an output directory'); process.exit(2); }
if (!ENV_FILE || !existsSync(ENV_FILE)) { console.error('ATAG_TEST_ENV must name a .env file holding OPENROUTER_API_KEY'); process.exit(2); }

const ENV = Object.fromEntries(readFileSync(ENV_FILE, 'utf8').split('\n')
  .map((l) => l.replace(/^\s*export\s+/, '').trim())
  .filter((l) => l && !l.startsWith('#') && l.includes('='))
  .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')]));
const KEY = ENV.OPENROUTER_API_KEY || '';
if (!KEY) { console.error(`${ENV_FILE} has no OPENROUTER_API_KEY`); process.exit(2); }

/** Anything that goes to the console, the report or the summary passes through here. */
const redact = (v) => {
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return s;
  for (const secret of Object.values(ENV)) if (secret && secret.length >= 12) s = s.split(secret).join('[redacted]');
  return s.replace(/sk-or-[A-Za-z0-9_-]{10,}/g, '[redacted]');
};

const PROMPT_IMAGE = 'a red apple on a wooden table, studio light';
const PROMPT_VIDEO = 'a paper boat floating on a calm lake, gentle camera pan';
const SEED = 42;
const MIN = 60 * 1000;
const DOWNLOAD_CAP = 40 * MIN;
const JOB_CAP = 15 * MIN;

/* ------------------------------------------------------- never real data -- */
const OUT = resolve(OUT_RAW);
mkdirSync(OUT, { recursive: true });
const OUT_REAL = realpathSync(OUT);
const realProfiles = () => {
  const homes = [...new Set([process.env.HOME, homedir()].filter(Boolean))];
  const list = homes.flatMap((h) => [join(h, '.atomic-agent'), join(h, '.atomic-agent-desktop'), join(h, 'Library', 'Application Support', 'Atomic Agent')]);
  if (process.env.ATOMIC_AGENT_DESKTOP_STATE_DIR) list.push(process.env.ATOMIC_AGENT_DESKTOP_STATE_DIR);
  return list.map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
};
const inside = (p, dir) => {
  const a = (process.platform === 'darwin' ? p.toLowerCase() : p), b = (process.platform === 'darwin' ? dir.toLowerCase() : dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};
for (const real of realProfiles()) {
  if (inside(OUT_REAL, real) || inside(real, OUT_REAL)) {
    console.error(`refusing to run: ${OUT} overlaps real app data (${real})`);
    process.exit(2);
  }
}
const stateDir = mkdtempSync(join(OUT_REAL, 'state-'));
const workspace = join(stateDir, 'workspace');
mkdirSync(workspace, { recursive: true });
assertThrowawayStateDir(stateDir);
for (const real of realProfiles()) if (inside(stateDir, real)) { console.error(`refusing to run: ${stateDir} is inside ${real}`); process.exit(2); }
copyFileSync(ENV_FILE, join(stateDir, '.env'));
/* STUDIO_LIVE_SEED_MODELS: a previous run's state dir whose models/diffusion is
   cloned in (APFS clonefile via cp -c), so a re-run skips a multi-GB download. */
if (process.env.STUDIO_LIVE_SEED_MODELS) {
  const from = join(process.env.STUDIO_LIVE_SEED_MODELS, 'models', 'diffusion');
  if (existsSync(from)) {
    mkdirSync(join(stateDir, 'models'), { recursive: true });
    execFileSync('cp', ['-cR', from, join(stateDir, 'models', 'diffusion')]);
    console.log(`studio-live: seeded diffusion models from ${from}`);
  }
}
chmodSync(join(stateDir, '.env'), 0o600);
const shotsDir = join(OUT_REAL, 'screenshots');
mkdirSync(shotsDir, { recursive: true });

console.log(`studio-live: out ${OUT_REAL}`);
console.log(`studio-live: state ${stateDir} (fresh, .env copied, key not shown)`);

/* --------------------------------------------------------------- record -- */
const startedAt = new Date();
const summary = {
  startedAt: startedAt.toISOString(), finishedAt: null,
  stateDir, out: OUT_REAL, port: PORT,
  prompts: { image: PROMPT_IMAGE, video: PROMPT_VIDEO }, seed: SEED,
  setup: null, steps: [], gpuShare: { before: null, after: null, afterSettle: null, note: '' },
  cleanup: null, ok: false,
};
const secs = (ms) => (typeof ms === 'number' ? Math.round(ms / 100) / 10 : null);
const log = (s) => console.log(`   ${redact(s)}`);

let app = null;

async function shot(name) {
  if (!app) return null;
  try { return await app.screenshot(join(shotsDir, `${name}.png`)); } catch (e) { log(`screenshot ${name} failed: ${e.message}`); return null; }
}

async function runStep(id, title, body) {
  const rec = { id, title, ok: false, error: null, screenshot: null, startedAt: new Date().toISOString(), secs: null, data: {} };
  summary.steps.push(rec);
  console.log(`\n▶ ${id}: ${title}`);
  const t0 = Date.now();
  try {
    if (!app) throw new Error('the app is not running');
    await body(rec.data, rec);
    rec.ok = true;
    console.log(`✔ ${id} passed in ${secs(Date.now() - t0)} s`);
  } catch (e) {
    rec.error = redact(e && e.message ? e.message : String(e));
    console.log(`✘ ${id} FAILED: ${rec.error}`);
    rec.screenshot = await shot(`${id}-failure`);
    try {
      rec.data.pageText = redact(await app.eval(`((document.querySelector('#content')||document.body).innerText||'').replace(/\\s+/g,' ').trim().slice(0, 1500)`));
    } catch { /* window gone */ }
  }
  rec.secs = secs(Date.now() - t0);
  return rec;
}

/* ------------------------------------------------------- page plumbing --
   One observer in the page records every Studio job, local-model and
   memory-share event, and long bridge calls are started in the page and
   polled for (a CDP evaluate gives up after 30 s; a model load does not). */
const RECORDER = `(() => {
  if (window.__studioLive) return true;
  const s = window.atomic && window.atomic.studio;
  if (!s) return false;
  const R = window.__studioLive = { jobs: {}, local: [], dl: {}, engine: null, load: null, gpu: [], calls: {} };
  s.onJob((j) => { if (!j || !j.id) return; const prev = R.jobs[j.id]; R.jobs[j.id] = Object.assign({}, j, { seenAt: prev ? prev.seenAt : Date.now(), lastAt: Date.now() }); });
  if (s.onLocal) s.onLocal((e) => {
    R.local.push({ at: Date.now(), type: e && e.type, id: e && (e.id || (e.download && e.download.id)), state: e && (e.state || (e.download && e.download.state) || (e.engine && e.engine.state)) });
    if (R.local.length > 300) R.local.shift();
    if (e && e.type === 'download' && e.download) R.dl[e.download.id] = Object.assign({ at: Date.now() }, e.download);
    if (e && e.type === 'engine') R.engine = Object.assign({ at: Date.now() }, e.engine);
    if (e && e.type === 'load') R.load = Object.assign({ at: Date.now() }, e);
  });
  if (s.onGpuShare) s.onGpuShare((st) => { R.gpu.push({ at: Date.now(), st }); if (R.gpu.length > 100) R.gpu.shift(); });
  return true;
})()`;

async function ensureRecorder() {
  const ok = await app.eval(RECORDER);
  if (!ok) throw new Error('window.atomic.studio is missing: this build has no Studio bridge');
}

/** Start BR.studio[method](...args) in the page; the answer lands in __studioLive.calls[name]. */
async function startCall(name, method, args = []) {
  await ensureRecorder();
  await app.eval(`(() => {
    const R = window.__studioLive, s = window.atomic.studio;
    R.calls[${JSON.stringify(name)}] = { pending: true, t0: Date.now() };
    const done = (r) => { R.calls[${JSON.stringify(name)}] = { pending: false, r, t0: R.calls[${JSON.stringify(name)}].t0, t1: Date.now() }; };
    try { Promise.resolve(s[${JSON.stringify(method)}](...${JSON.stringify(args)})).then(done, (e) => done({ ok: false, error: { code: 'THREW', message: String((e && e.message) || e) } })); }
    catch (e) { done({ ok: false, error: { code: 'THREW', message: String((e && e.message) || e) } }); }
    return true;
  })()`);
}
async function waitCall(name, timeout, { every = 0, tick = null } = {}) {
  const until = Date.now() + timeout;
  let lastTick = Date.now();
  for (;;) {
    const c = await app.eval(`(window.__studioLive && window.__studioLive.calls[${JSON.stringify(name)}]) || null`);
    if (c && !c.pending) return c;
    if (Date.now() > until) throw new Error(`BR.studio call "${name}" did not answer within ${Math.round(timeout / 1000)} s`);
    if (tick && every && Date.now() - lastTick >= every) { lastTick = Date.now(); await tick(); }
    await sleep(1000);
  }
}
async function call(method, args = [], timeout = 3 * MIN) {
  const name = `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await startCall(name, method, args);
  const c = await waitCall(name, timeout);
  return { r: c.r, ms: c.t1 - c.t0 };
}
const unwrap = (r, what) => {
  if (r && r.ok) return r.data;
  const e = (r && r.error) || {};
  throw new Error(`${what}: ${e.code || 'NO_ANSWER'} ${e.message || ''}`.trim());
};

/** Open a Studio page the way a person does: the sidebar row; the shell's own open() if the row is not there. */
async function openStudio(kind) {
  try {
    await app.clickSel(`[data-act="studio:open:${kind}"]`, { timeout: 10000 });
  } catch {
    log(`no sidebar row for ${kind}; opening through STUDIO.open`);
    await app.eval(`(window.STUDIO && window.STUDIO.open(${JSON.stringify(kind)}), true)`);
  }
  await app.waitFor(`window.STUDIO && window.STUDIO.current() === ${JSON.stringify(kind)} && !!document.querySelector('[data-studio="${kind}"]')`,
    `Studio › ${kind} on screen`, { timeout: 20000 });
  await ensureRecorder();
}

/** Wait for a job to end, following a queued `q-…` id into the Core job that replaced it. */
async function waitJob(kind, jobId, timeout, label) {
  const t0 = Date.now();
  const until = t0 + timeout;
  let id = jobId;
  let lastLog = 0;
  let last = null;
  for (;;) {
    const j = await app.eval(`(() => {
      const J = (window.__studioLive && window.__studioLive.jobs) || {};
      const id = ${JSON.stringify(id)};
      const swap = Object.values(J).find((x) => x.replaces === id);
      return swap || J[id] || null;
    })()`);
    if (j) { last = j; if (j.id !== id) { log(`${label}: queued ${id} became ${j.id}`); id = j.id; } }
    if (!j || Date.now() - lastLog > 15000) {
      // The event stream is the main source; ask for the job too, as the page's own poll does.
      try { const r = await app.eval(`window.atomic.studio.job(${JSON.stringify(kind)}, ${JSON.stringify(id)})`); if (r && r.ok && r.data) last = r.data; } catch { /* keep the events */ }
    }
    if (last && ['completed', 'failed', 'cancelled'].includes(last.state)) return { job: last, waitedMs: Date.now() - t0 };
    if (Date.now() - lastLog >= 30000) {
      lastLog = Date.now();
      const p = last && last.progress;
      log(`${label}: ${last ? last.state : 'no word yet'}${p ? ` · ${p.phase} ${Math.round((p.fraction || 0) * 100)}%${p.etaSeconds ? ` · eta ${Math.round(p.etaSeconds)} s` : ''}` : ''} · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    if (Date.now() > until) {
      try { await app.eval(`window.atomic.studio.cancel(${JSON.stringify(kind)}, ${JSON.stringify(id)})`); } catch { /* best effort */ }
      throw new Error(`${label} did not finish within ${Math.round(timeout / 60000)} min (last state: ${last ? last.state : 'none'}); stopped it`);
    }
    await sleep(2000);
  }
}

/** A new job of this kind that appeared after `since`, not one of `known`. */
async function waitNewJob(kind, known, since, timeout, errorSel) {
  const until = Date.now() + timeout;
  for (;;) {
    const got = await app.eval(`(() => {
      const J = (window.__studioLive && window.__studioLive.jobs) || {};
      const known = new Set(${JSON.stringify(known)});
      const fresh = Object.values(J).filter((j) => j.kind === ${JSON.stringify(kind)} && !known.has(j.id) && j.seenAt >= ${since} - 1000)
        .sort((a, b) => a.seenAt - b.seenAt);
      const err = document.querySelector(${JSON.stringify(errorSel)});
      return { job: fresh[0] || null, err: err ? (err.innerText || '').replace(/\\s+/g, ' ').trim() : '' };
    })()`);
    if (got.job) return got.job;
    if (got.err) throw new Error(`the page refused to start: ${got.err}`);
    if (Date.now() > until) throw new Error(`no ${kind} job started within ${Math.round(timeout / 1000)} s of clicking Generate`);
    await sleep(1000);
  }
}
const knownJobs = (kind) => app.eval(`Object.values((window.__studioLive && window.__studioLive.jobs) || {}).filter((j) => j.kind === ${JSON.stringify(kind)}).map((j) => j.id)`);

function fileFacts(item) {
  if (!item) return null;
  let bytesOnDisk = null;
  try { bytesOnDisk = statSync(item.path).size; } catch { /* not on this disk */ }
  return { path: item.path, bytesOnDisk, sizeBytes: item.sizeBytes ?? null, width: item.width ?? null, height: item.height ?? null,
    durationSecs: item.durationSecs ?? null, model: item.model || null, underStateDir: typeof item.path === 'string' && inside(item.path, stateDir) };
}
const jobTimes = (job) => ({ coreCreatedAt: job && job.createdAtMs ? new Date(job.createdAtMs).toISOString() : null,
  coreSecs: job && job.createdAtMs && job.finishedAtMs ? secs(job.finishedAtMs - job.createdAtMs) : null });

async function setField(sel, text) {
  await app.clickSel(sel);
  await app.eval(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await app.type(text, { perChar: 3 });
  const got = await app.eval(`(document.querySelector(${JSON.stringify(sel)})||{}).value`);
  if (got !== text) throw new Error(`the prompt box holds ${JSON.stringify(String(got).slice(0, 80))}, not what was typed`);
}

/* ---------------------------------------------------------------- steps -- */
async function stepLocalImage(d) {
  await openStudio('images');
  summary.gpuShare.before = (await call('gpuShare')).r?.data ?? null;
  summary.gpuShare.note = 'The chat route is the OpenRouter cloud set up by the wizard, so no local chat model is configured: chat is expected to read "off" and nothing to be paused.';
  log(`gpuShare before: ${JSON.stringify(summary.gpuShare.before)}`);

  const { r: catR, ms: catMs } = await call('catalog', ['image'], 5 * MIN);
  const cat = unwrap(catR, 'catalog(image)');
  const local = cat.local || {};
  d.catalogSecs = secs(catMs);
  d.machine = local.machine || null;
  d.modelsDir = local.modelsDir || null;
  d.localCatalogError = local.error || null;
  d.engineBefore = local.engine || null;
  if (d.modelsDir && !inside(resolve(d.modelsDir), stateDir) && !inside(resolve(d.modelsDir), realpathSync(stateDir))) {
    throw new Error(`the local models folder ${d.modelsDir} is outside the throwaway state dir; not downloading there`);
  }
  const families = (local.models || []).filter((m) => /z[-_ ]?image/i.test(`${m.id} ${m.name}`));
  d.zImageFamilies = families.map((m) => m.id);
  const quants = families.flatMap((m) => ((m.local && m.local.quants) || []).map((q) => ({ ...q, family: m.id, familyName: m.name, gated: !!(m.local && m.local.gated) })))
    .filter((q) => !q.gated && Number.isFinite(q.bytes));
  if (!quants.length) throw new Error(`no downloadable Z-Image quant in the local catalog (families: ${(local.models || []).map((m) => m.id).join(', ') || 'none'})`);
  quants.sort((a, b) => a.bytes - b.bytes);
  const q = quants[0];
  d.model = { id: q.id, family: q.family, name: q.familyName, quant: q.label, bytes: q.bytes, downloadBytes: q.downloadBytes, fit: q.fit ? { verdict: q.fit.verdict, reason: q.fit.reason } : null, pausesChat: q.pausesChat };
  log(`smallest Z-Image: ${q.id} (${(q.bytes / 1e9).toFixed(2)} GB, fit ${q.fit && q.fit.verdict})`);

  // Download.
  const tDl = Date.now();
  if (q.installed) {
    d.download = { skipped: 'already installed', secs: 0 };
  } else {
    const { r: dlR } = await call('localDownload', [q.id]);
    const first = unwrap(dlR, `localDownload(${q.id})`);
    let state = first.state;
    let lastLog = Date.now();
    let dl = first;
    while (state !== 'done') {
      if (state === 'failed' || state === 'cancelled') throw new Error(`download ${state}: ${dl.error ? `${dl.error.code} ${dl.error.message}` : 'no reason given'}`);
      if (Date.now() - tDl > DOWNLOAD_CAP) {
        await call('localCancel', [q.id]).catch(() => null);
        throw new Error(`download not done after ${DOWNLOAD_CAP / MIN} min (${Math.round(dl.percent || 0)}%); stopped`);
      }
      await sleep(5000);
      const ev = await app.eval(`(window.__studioLive.dl[${JSON.stringify(q.id)}]) || null`);
      if (ev) { dl = ev; state = ev.state; }
      if (Date.now() - lastLog >= 30000) {
        lastLog = Date.now();
        log(`download ${q.id}: ${state} ${Math.round(dl.percent || 0)}% · ${((dl.transferred || 0) / 1e6).toFixed(0)}/${((dl.total || 0) / 1e6).toFixed(0)} MB`
          + `${dl.file ? ` · file ${dl.file.index}/${dl.file.count} ${dl.file.name}` : ''} · ${Math.round((Date.now() - tDl) / 1000)} s`);
      }
    }
    const mb = (dl.total || q.downloadBytes || 0) / 1e6;
    d.download = { secs: secs(Date.now() - tDl), bytes: dl.total || q.downloadBytes || null, mbPerSec: mb ? Math.round((mb / ((Date.now() - tDl) / 1000)) * 10) / 10 : null };
  }
  log(`download: ${JSON.stringify(d.download)}`);

  // Generate: engine install and model load happen before generateImage answers.
  const req = { provider: 'local', model: q.id, mode: 'create', prompt: PROMPT_IMAGE, count: 1, seed: SEED, width: 512, height: 512 };
  d.request = req;
  const tGen = Date.now();
  await startCall('genLocal', 'generateImage', [req]);
  const started = await waitCall('genLocal', JOB_CAP, { every: 30000, tick: async () => {
    const st = await app.eval(`({ engine: window.__studioLive.engine, load: window.__studioLive.load })`);
    log(`preparing: engine ${st.engine ? `${st.engine.state}${st.engine.progress ? ` ${Math.round(st.engine.progress.percent)}%` : ''}` : '—'} · load ${st.load ? `${st.load.state} ${st.load.message || ''}` : '—'} · ${Math.round((Date.now() - tGen) / 1000)} s`);
  } });
  const g = unwrap(started.r, 'generateImage(local)');
  d.prepareSecs = secs(started.t1 - started.t0);
  d.engineAfter = await app.eval(`window.__studioLive.engine`);
  d.load = await app.eval(`window.__studioLive.load`);
  log(`job ${g.jobId} started after ${d.prepareSecs} s (engine install + model load)`);
  const left = Math.max(MIN, JOB_CAP - (Date.now() - tGen));
  const { job, waitedMs } = await waitJob('image', g.jobId, left, 'local image');
  d.jobId = job.id;
  d.jobSecs = secs(waitedMs);
  d.totalSecs = secs(Date.now() - tGen);
  Object.assign(d, jobTimes(job));
  summary.gpuShare.after = (await call('gpuShare')).r?.data ?? null;
  log(`gpuShare after: ${JSON.stringify(summary.gpuShare.after)}`);
  if (job.state !== 'completed') throw new Error(`local image ${job.state}: ${job.error ? `${job.error.code} ${job.error.message}` : 'no reason given'}`);
  const item = (job.outputs || [])[0];
  if (!item) throw new Error('the job completed with no output');
  d.output = fileFacts(item);
  log(`output ${d.output.path} · ${d.output.bytesOnDisk} bytes · ${d.output.width}×${d.output.height}`);
  await app.eval(`(window.STUDIO.act('images:sel:' + ${JSON.stringify(item.id)}), true)`);
  try { await app.waitFor(`!!document.querySelector('[data-studio="images"] .st-viewer.well')`, 'the picture on the stage', { timeout: 15000 }); } catch { log('the stage did not show the picture within 15 s'); }
  await sleep(1500);
  d.screenshot = await shot('A-local-image');
  if (d.output.width && d.output.width !== 512) throw new Error(`asked for 512 px, got ${d.output.width}×${d.output.height}`);
  // The chat model restarts 20 s after the last local generation; read the share again after that.
  await sleep(25000);
  summary.gpuShare.afterSettle = (await call('gpuShare')).r?.data ?? null;
  d.gpuEvents = await app.eval(`window.__studioLive.gpu.map((g) => ({ at: new Date(g.at).toISOString(), chat: g.st && g.st.chat, generating: g.st && g.st.generating ? g.st.generating.kind : null, queued: g.st && g.st.queued }))`);
}

async function stepCloudImage(d) {
  await openStudio('images');
  // A card left by step A (its error) would read as this step's refusal: put it away first.
  if (await app.eval(`!!document.querySelector('[data-studio="images"] .st-err')`)) await app.eval(`(window.STUDIO.act('images:dismiss'), true)`);
  const { r: catR } = await call('catalog', ['image'], 5 * MIN);
  const cat = unwrap(catR, 'catalog(image)');
  const cloud = cat.cloud || {};
  d.keyMissing = !!cloud.keyMissing;
  d.live = !!cloud.live;
  d.catalogError = cloud.error || null;
  const m = (cloud.models || []).find((x) => x.default) || (cloud.models || [])[0];
  if (!m) throw new Error(`no cloud image models listed${cloud.error ? `: ${cloud.error.message}` : ''}`);
  d.model = { id: m.id, name: m.name, provider: m.provider };
  if (d.keyMissing) throw new Error('Studio says the OpenRouter key is missing (keyMissing: true)');
  log(`default cloud image model: ${m.id}`);

  await app.eval(`(window.STUDIO.act('images:model:' + ${JSON.stringify(`${m.provider}|${m.id}`)}), true)`);
  await app.waitFor(`!!document.querySelector('[data-studio="images"] .st-go:not([disabled])') && !document.querySelector('[data-studio="images"] .st-go.stop')`,
    'the Generate button ready', { timeout: 60000 });
  await setField('#sti-prompt', PROMPT_IMAGE);
  // The price is asked for 250 ms after the form settles; give it a moment to land on the button.
  const btn = `((document.querySelector('[data-studio="images"] .st-go')||{}).innerText||'').replace(/\\s+/g,' ').trim()`;
  try { await app.waitFor(`/≈|\\$/.test(${btn})`, 'a price on the Generate button', { timeout: 20000 }); } catch { log('no price on the button within 20 s'); }
  d.buttonText = await app.eval(btn);
  d.priceShown = (d.buttonText.match(/≈\s*\$[\d.]+(?:–[\d.]+)?/) || [null])[0];
  d.estimateLine = await app.eval(`((document.querySelector('[data-studio="images"] [data-foot] .st-est')||{}).innerText||'').trim()`);
  log(`button: ${JSON.stringify(d.buttonText)}`);

  const known = await knownJobs('image');
  const tGen = Date.now();
  await app.clickSel('[data-studio="images"] .st-go');
  const first = await waitNewJob('image', known, tGen, 2 * MIN, '[data-studio="images"] .st-err');
  d.startSecs = secs(first.seenAt - tGen);
  const { job, waitedMs } = await waitJob('image', first.id, JOB_CAP, 'cloud image');
  d.jobId = job.id;
  d.jobModel = job.model;
  d.jobSecs = secs(waitedMs);
  d.totalSecs = secs(Date.now() - tGen);
  Object.assign(d, jobTimes(job));
  if (job.state !== 'completed') throw new Error(`cloud image ${job.state}: ${job.error ? `${job.error.code} ${job.error.message}` : 'no reason given'}`);
  const item = (job.outputs || [])[0];
  if (!item) throw new Error('the job completed with no output');
  d.output = fileFacts(item);
  log(`output ${d.output.path} · ${d.output.bytesOnDisk} bytes · ${d.output.width}×${d.output.height}`);
  try { await app.waitFor(`!!document.querySelector('[data-studio="images"] .st-viewer.well')`, 'the picture on the stage', { timeout: 15000 }); } catch { log('the stage did not show the picture within 15 s'); }
  await sleep(1500);
  d.screenshot = await shot('B-cloud-image');
}

async function stepCloudVideo(d) {
  await openStudio('video');
  const { r: catR } = await call('catalog', ['video'], 5 * MIN);
  const cat = unwrap(catR, 'catalog(video)');
  const cloud = cat.cloud || {};
  d.keyMissing = !!cloud.keyMissing;
  d.catalogError = cloud.error || null;
  const m = (cloud.models || []).find((x) => x.default) || (cloud.models || [])[0];
  if (!m) throw new Error(`no cloud video models listed${cloud.error ? `: ${cloud.error.message}` : ''}`);
  d.model = { id: m.id, name: m.name, durations: m.durations || null, aspectRatios: m.aspectRatios ? m.aspectRatios.values : null };
  if (d.keyMissing) throw new Error('Studio says the OpenRouter key is missing (keyMissing: true)');
  log(`default cloud video model: ${m.id}`);

  const root = '[data-studio="video"]';
  await app.waitFor(`!!document.querySelector('${root} .studio-go') || !!document.querySelector('${root} .studio-video-err')`, 'the video form', { timeout: 60000 });
  const err = await app.eval(`((document.querySelector('${root} .studio-video-err')||{}).innerText||'').trim()`);
  if (err) throw new Error(`the video page says: ${err}`);
  if (await app.eval(`!!document.querySelector('${root} [data-vact="mode"][data-v="text"]:not(.on)')`)) await app.clickSel(`${root} [data-vact="mode"][data-v="text"]`);
  if (await app.eval(`!!document.querySelector('${root} [data-vact="dur"][data-v="4"]')`)) {
    await app.clickSel(`${root} [data-vact="dur"][data-v="4"]`);
    d.duration = 4;
  } else {
    d.duration = await app.eval(`(() => { const b = document.querySelector('${root} [data-vact="dur"].on'); return b ? b.getAttribute('data-v') : null; })()`);
    d.durationNote = `4 s is not offered for ${m.id}; left at ${d.duration ?? 'the model default'}`;
    log(d.durationNote);
  }
  if (await app.eval(`!!document.querySelector('${root} [data-vact="aspect"][data-v="16:9"]')`)) {
    await app.clickSel(`${root} [data-vact="aspect"][data-v="16:9"]`);
    d.aspect = '16:9';
  } else {
    d.aspectNote = `16:9 is not offered for ${m.id}`;
    log(d.aspectNote);
  }
  await setField('#sv-prompt', PROMPT_VIDEO);
  const btn = `((document.querySelector('${root} .studio-go')||{}).innerText||'').replace(/\\s+/g,' ').trim()`;
  try { await app.waitFor(`/≈|\\$/.test(${btn})`, 'a price on the Generate button', { timeout: 20000 }); } catch { log('no price on the button within 20 s'); }
  d.buttonText = await app.eval(btn);
  d.priceShown = (d.buttonText.match(/≈\s*\$[\d.]+(?:–[\d.]+)?/) || [null])[0];
  log(`button: ${JSON.stringify(d.buttonText)}`);
  if (await app.eval(`!!document.querySelector('${root} .studio-go[disabled]')`)) {
    throw new Error(`the Generate button is disabled: ${await app.eval(`(document.querySelector('${root} .studio-go')||{}).title || ''`)}`);
  }

  const known = await knownJobs('video');
  const tGen = Date.now();
  await app.clickSel(`${root} .studio-go`);
  const first = await waitNewJob('video', known, tGen, 2 * MIN, `${root} .studio-video-err, ${root} .studio-err`);
  d.startSecs = secs(first.seenAt - tGen);
  const { job, waitedMs } = await waitJob('video', first.id, JOB_CAP, 'cloud video');
  d.jobId = job.id;
  d.jobModel = job.model;
  d.jobSecs = secs(waitedMs);
  d.totalSecs = secs(Date.now() - tGen);
  Object.assign(d, jobTimes(job));
  if (job.state !== 'completed') throw new Error(`cloud video ${job.state}: ${job.error ? `${job.error.code} ${job.error.message}` : 'no reason given'}`);
  const item = (job.outputs || [])[0];
  if (!item) throw new Error('the job completed with no output');
  d.output = fileFacts(item);
  log(`output ${d.output.path} · ${d.output.bytesOnDisk} bytes · ${d.output.durationSecs ?? '?'} s`);
  await app.waitFor(`!!document.querySelector('${root} .studio-video-player[src]') || !!document.querySelector('${root} .studio-video-noplay')`,
    'the player (or the cannot-play note)', { timeout: 30000 });
  try {
    await app.waitFor(`(() => { const v = document.querySelector('${root} .studio-video-player'); return !!v && (v.readyState >= 1 || !!v.error); })()`,
      'the clip metadata', { timeout: 15000 });
  } catch { log('the player did not read the clip metadata within 15 s'); }
  d.player = await app.eval(`(() => { const v = document.querySelector('${root} .studio-video-player');
    return { present: !!v, noPlay: !!document.querySelector('${root} .studio-video-noplay'), readyState: v ? v.readyState : null,
      duration: v && Number.isFinite(v.duration) ? Math.round(v.duration * 10) / 10 : null,
      videoWidth: v ? v.videoWidth : null, videoHeight: v ? v.videoHeight : null, error: v && v.error ? v.error.code : null }; })()`);
  log(`player: ${JSON.stringify(d.player)}`);
  await sleep(1000);
  d.screenshot = await shot('C-cloud-video');
  if (!d.player.present || d.player.noPlay) throw new Error('the clip was made but the page shows no playable player');
}

/* -------------------------------------------------------------- cleanup -- */
function killUnderStateDir() {
  const needles = [...new Set([stateDir, (() => { try { return realpathSync(stateDir); } catch { return stateDir; } })()])];
  let rows = [];
  try { rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n'); } catch { return { killed: [], error: 'ps failed' }; }
  const hits = rows.map((l) => l.trim()).filter(Boolean).map((l) => ({ pid: Number(l.split(/\s+/)[0]), cmd: l.slice(l.indexOf(' ') + 1) }))
    .filter((p) => p.pid && p.pid !== process.pid && needles.some((n) => p.cmd.includes(n)));
  for (const p of hits) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } }
  return { hits, needles };
}
async function cleanup() {
  const rec = { appClosed: false, killed: [] };
  if (app) { try { await app.close(); rec.appClosed = true; } catch (e) { rec.appCloseError = e.message; } }
  const first = killUnderStateDir();
  if (first.hits && first.hits.length) {
    await sleep(3000);
    const second = killUnderStateDir();
    for (const p of second.hits || []) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }
    rec.killed = first.hits.map((p) => ({ pid: p.pid, cmd: p.cmd.split(stateDir).join('<state>').slice(0, 160) }));
    rec.stillThereAfterTerm = (second.hits || []).map((p) => p.pid);
  }
  try { rmSync(join(stateDir, '.env'), { force: true }); rec.envRemoved = true; } catch { rec.envRemoved = false; }
  if (CLEAN) { try { rmSync(stateDir, { recursive: true, force: true }); rec.stateDirRemoved = true; } catch (e) { rec.stateDirRemoved = false; } }
  return rec;
}

/* --------------------------------------------------------------- report -- */
function writeReport() {
  summary.finishedAt = new Date().toISOString();
  summary.ok = !!(summary.setup && summary.setup.ok) && summary.steps.length === 3 && summary.steps.every((s) => s.ok);
  const json = redact(JSON.stringify(summary, null, 2));
  writeFileSync(join(OUT_REAL, 'summary.json'), json);
  const S = JSON.parse(json);
  const v = (x) => (x == null || x === '' ? '—' : String(x));
  const mb = (b) => (typeof b === 'number' ? `${(b / 1e6).toFixed(2)} MB` : '—');
  const L = [];
  L.push('# Studio live drive', '');
  L.push(`Run ${S.startedAt} → ${S.finishedAt}. Result: **${S.ok ? 'PASS' : 'FAIL'}**.`, '');
  L.push(`State dir (throwaway): \`${S.stateDir}\``, '');
  L.push(`Setup (launch + first run on OpenRouter): ${S.setup && S.setup.ok ? 'ok' : `FAILED: ${v(S.setup && S.setup.error)}`}`
    + `${S.setup && S.setup.model ? ` · chat model ${S.setup.model}` : ''}${S.setup && S.setup.secs != null ? ` · ${S.setup.secs} s` : ''}`, '');
  L.push('| Step | Result | Model | Price on button | Prepare / start | Job | Total | Output | Size |', '|---|---|---|---|---|---|---|---|---|');
  for (const s of S.steps) {
    const d = s.data || {};
    const model = d.model ? (d.model.id || d.model.name) : d.jobModel;
    const prep = d.prepareSecs != null ? `${d.prepareSecs} s` : d.startSecs != null ? `${d.startSecs} s` : '—';
    L.push(`| ${s.id} ${s.title} | ${s.ok ? 'pass' : 'FAIL'} | ${v(model)} | ${v(d.priceShown || (s.id === 'A' ? 'free (local)' : null))} | ${prep} | ${d.jobSecs != null ? `${d.jobSecs} s` : '—'} | ${d.totalSecs != null ? `${d.totalSecs} s` : '—'} | ${d.output ? `\`${d.output.path}\`` : '—'} | ${d.output ? mb(d.output.bytesOnDisk ?? d.output.sizeBytes) : '—'} |`);
  }
  L.push('');
  for (const s of S.steps) {
    const d = s.data || {};
    L.push(`## ${s.id}. ${s.title}: ${s.ok ? 'pass' : 'FAIL'}`, '');
    if (s.error) L.push(`Error: ${s.error}`, '');
    if (s.id === 'A') {
      if (d.model) L.push(`- Model: ${d.model.id} (${d.model.name}, ${d.model.quant}), ${mb(d.model.bytes)}, fit ${v(d.model.fit && d.model.fit.verdict)}`);
      if (d.download) L.push(`- Download: ${d.download.skipped ? d.download.skipped : `${d.download.secs} s, ${mb(d.download.bytes)}, ${v(d.download.mbPerSec)} MB/s`}`);
      if (d.prepareSecs != null) L.push(`- Engine install + model load (Generate → job started): ${d.prepareSecs} s; engine ${v(d.engineAfter && d.engineAfter.state)}`);
      if (d.output) L.push(`- Picture: ${d.output.width}×${d.output.height}, seed ${S.seed}`);
      L.push(`- gpuShare before: \`${JSON.stringify(S.gpuShare.before)}\``);
      L.push(`- gpuShare after the job: \`${JSON.stringify(S.gpuShare.after)}\``);
      L.push(`- gpuShare 25 s later: \`${JSON.stringify(S.gpuShare.afterSettle)}\``);
      if (S.gpuShare.note) L.push(`- ${S.gpuShare.note}`);
    }
    if (s.id === 'B' || s.id === 'C') {
      if (d.buttonText) L.push(`- Generate button read: "${d.buttonText}"`);
      if (d.jobModel) L.push(`- Job model: ${d.jobModel}`);
      if (d.durationNote) L.push(`- ${d.durationNote}`);
      if (d.aspectNote) L.push(`- ${d.aspectNote}`);
      if (d.player) L.push(`- Player: ${JSON.stringify(d.player)}`);
    }
    if (d.coreSecs != null) L.push(`- Core's own job time: ${d.coreSecs} s`);
    const sh = d.screenshot || s.screenshot;
    if (sh) L.push(`- Screenshot: \`${sh}\``);
    L.push('');
  }
  if (S.cleanup) {
    L.push('## Cleanup', '', `App closed: ${S.cleanup.appClosed}. Processes left under the state dir and killed: ${S.cleanup.killed.length ? S.cleanup.killed.map((k) => `${k.pid} (${k.cmd})`).join('; ') : 'none'}.`
      + ` Copied .env removed: ${S.cleanup.envRemoved}.${CLEAN ? ` State dir removed: ${S.cleanup.stateDirRemoved}.` : ' State dir kept (models included); STUDIO_LIVE_CLEAN=1 removes it.'}`, '');
  }
  writeFileSync(join(OUT_REAL, 'report.md'), redact(L.join('\n')));
  console.log(`\nsummary: ${join(OUT_REAL, 'summary.json')}\nreport:  ${join(OUT_REAL, 'report.md')}`);
}

/* ----------------------------------------------------------------- main -- */
let exitCode = 1;
try {
  const tSetup = Date.now();
  summary.setup = { ok: false, error: null, secs: null, model: null };
  try {
    app = await launch({ port: PORT, stateDir, workspace, verbose: true, env: { ATOMIC_AGENT_DESKTOP_STATE_DIR: stateDir } });
    await firstRun(app, { provider: 'openrouter', key: KEY });
    try {
      const cfg = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
      const list = cfg?.llm?.providers ?? [];
      const e = list.find((p) => p.id === cfg?.llm?.activeTextProvider) ?? list[0];
      summary.setup.model = e ? `${e.id} · ${e.defaultChatModel ?? e.model ?? 'default model'}` : null;
    } catch { /* config not readable: the model stays unnamed */ }
    summary.setup.ok = true;
  } catch (e) {
    summary.setup.error = redact(e && e.message ? e.message : String(e));
    console.log(`✘ setup FAILED: ${summary.setup.error}`);
    summary.setup.screenshot = await shot('setup-failure');
  }
  summary.setup.secs = secs(Date.now() - tSetup);

  await runStep('A', 'Local image (smallest Z-Image, 512 px, fixed seed)', stepLocalImage);
  await runStep('B', 'Cloud image (default OpenRouter model)', stepCloudImage);
  await runStep('C', 'Cloud video (default model, 4 s, 16:9)', stepCloudVideo);
} catch (e) {
  console.log(`✘ the run stopped: ${redact(e && e.stack ? e.stack : String(e))}`);
} finally {
  summary.cleanup = await cleanup();
  writeReport();
  exitCode = summary.ok ? 0 : 1;
}
process.exit(exitCode);
