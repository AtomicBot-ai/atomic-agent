#!/usr/bin/env node
/**
 * The desktop smoke, from a plain `node` command on any platform (CI first,
 * Windows first of all).
 *
 * It builds nothing. It expects what the build steps leave behind:
 *   - desktop/out            (`npm run build` in desktop/)
 *   - an agent to run:       --agent-bin, else ATOMIC_AGENT_BIN, else the
 *                            staged bundle bundle/<platform-arch>/atomic-agent[.exe]
 *                            (`npx tsx scripts/package-bundle.ts <slug>`), else,
 *                            on macOS/Linux only, `node dist/cli/index.js`
 *                            through a small sh wrapper, as the QA kit's
 *                            smoke.sh does. Windows needs a real .exe:
 *                            Node will not spawn a .cmd shim without a shell.
 *
 * What it does is what the QA kit's smoke.sh does, without bash:
 *   1. makes a throwaway run directory with its own home, temp, agent state
 *      dir, workspace and Chromium profile (HOME/USERPROFILE/APPDATA/
 *      LOCALAPPDATA/TMP all point inside it, so nothing reaches the runner's
 *      or the operator's own ~/.atomic-agent or ~/.atomic-agent-desktop);
 *   2. launches the desktop's own smoke runner: `electron . --smoke`, with
 *      `--smoke-task=<ids>` (release-fix tasks), nothing more for `full`,
 *      `--smoke-fusion` for `fusion`. The checks themselves live in
 *      desktop/main (main.ts smokeTest, release-fixes-smoke.ts,
 *      smoke-tasks/tNN.ts); this script only starts the app and reads its
 *      `PASS …` / `FAIL …` / `SMOKE …` lines;
 *   3. streams the output and writes it to <out>/artifacts/smoke.log;
 *   4. compares the FAIL lines with a known-failures file (--known-failures)
 *      and exits non-zero only for a failure that is not on it, or when the
 *      run never finished (no `SMOKE …` summary line: a crash or a hang);
 *   5. copies the agent's logs (agent.log, model server logs) and any crash
 *      dump into <out>/artifacts for upload.
 *
 * Usage (from the repo root or anywhere):
 *   node desktop/scripts/smoke-ci.mjs                       # full suite
 *   node desktop/scripts/smoke-ci.mjs --tasks 108,111       # release-fix tasks
 *   node desktop/scripts/smoke-ci.mjs --tasks all           # every release-fix task
 *   node desktop/scripts/smoke-ci.mjs --tasks fusion        # the run-mode lane
 *     --known-failures <file>   lines that may FAIL without failing the run
 *     --out <dir>               run directory (default: a new dir under the OS temp)
 *     --agent-bin <path>        the agent executable to supervise
 *     --seed <dir>              copy a prepared state dir in first (the QA kit's seed-local)
 *     --start-model             `models start` before the app (smoke.sh does this for full)
 *     --timeout-min <n>         kill the app after n minutes (default 90 full, 30 otherwise)
 *     -- <electron args…>       passed to electron after the smoke flags
 *
 * Exit codes: 0 no unexpected failure · 1 unexpected FAIL lines ·
 *             2 the run did not finish (crash, hang, no checks) · 3 bad setup.
 *
 * Known-failures file: one entry per line; blank lines and lines starting
 * with `#` are ignored. An entry matches a FAIL line whose text (after
 * "FAIL ") is exactly the entry or starts with the entry followed by " — "
 * (the separator before the detail). An entry ending in `*` matches every
 * FAIL line that starts with the text before the `*` (e.g. `T44:*`).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync,
  readdirSync, statSync, writeFileSync, appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = resolve(HERE, "..");
const REPO = resolve(DESKTOP, "..");
const WIN = process.platform === "win32";

/* ------------------------------------------------------------ arguments --- */

function parseArgs(argv) {
  const o = { tasks: "full", knownFailures: null, out: null, agentBin: null, seed: null, startModel: false, timeoutMin: null, electronArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "--") { o.electronArgs = argv.slice(i + 1); break; }
    else if (a === "--tasks") o.tasks = val();
    else if (a.startsWith("--tasks=")) o.tasks = a.slice(8);
    else if (a === "--known-failures") o.knownFailures = val();
    else if (a === "--out") o.out = val();
    else if (a === "--agent-bin") o.agentBin = val();
    else if (a === "--seed") o.seed = val();
    else if (a === "--start-model") o.startModel = true;
    else if (a === "--timeout-min") o.timeoutMin = Number(val());
    else if (a === "-h" || a === "--help") { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/\n"); process.exit(0); }
    else die(`unknown argument: ${a}`);
  }
  o.tasks = String(o.tasks || "full").trim().toLowerCase().replace(/\s+/g, "");
  // Task ids are numbers with an optional letter (18, 108, 18b); the words are the suite modes.
  if (!/^(full|all|fusion|[0-9]{1,3}[a-z]?(,[0-9]{1,3}[a-z]?)*)$/.test(o.tasks)) {
    die(`--tasks must be full, all, fusion or a comma list of task ids (got ${JSON.stringify(o.tasks)})`);
  }
  if (o.timeoutMin === null) o.timeoutMin = o.tasks === "full" ? 90 : 30;
  if (!Number.isFinite(o.timeoutMin) || o.timeoutMin <= 0) die("--timeout-min must be a positive number");
  return o;
}

function die(msg, code = 3) {
  process.stderr.write(`smoke-ci: ${msg}\n`);
  process.exit(code);
}

/* ------------------------------------------------------- key scrubbing --- */

/* The smoke uses no real keys (a few checks type obvious fake ones), and on
   a public repository the job log and the uploaded artifact are public. So
   anything shaped like a real provider key is blanked on its way out, as a
   second line of defence, never as the first. */
const KEY_SHAPES = [
  /\bsk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[0-9]{8,10}:AA[0-9A-Za-z_-]{30,}/g, // Telegram bot token
];
function scrub(text) {
  let s = text;
  for (const re of KEY_SHAPES) s = s.replace(re, "[redacted]");
  return s;
}

/* ------------------------------------------------------ known failures --- */

function loadKnown(file) {
  if (!file) return [];
  const p = resolve(file);
  if (!existsSync(p)) die(`known-failures file not found: ${p}`);
  return readFileSync(p, "utf8").split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((entry) => ({ entry, prefix: entry.endsWith("*") ? entry.slice(0, -1) : null, hits: 0 }));
}

function knownEntryFor(known, failText) {
  for (const k of known) {
    if (k.prefix !== null ? failText.startsWith(k.prefix) : (failText === k.entry || failText.startsWith(k.entry + " — "))) return k;
  }
  return null;
}

/* ------------------------------------------------------------ the agent --- */

function bundleSlug() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${process.platform}-${arch}`;
}

function resolveAgentBin(opts, runDir) {
  const given = opts.agentBin ?? process.env.ATOMIC_AGENT_BIN ?? null;
  if (given) {
    const p = resolve(given);
    if (!existsSync(p)) die(`agent binary not found: ${p}`);
    if (WIN && /\.(cmd|bat|ps1)$/i.test(p)) die(`on Windows the agent must be an .exe (Node will not spawn ${basename(p)} without a shell): ${p}`);
    return p;
  }
  const bundled = join(REPO, "bundle", bundleSlug(), WIN ? "atomic-agent.exe" : "atomic-agent");
  if (existsSync(bundled)) return bundled;
  const cli = join(REPO, "dist", "cli", "index.js");
  if (!WIN && existsSync(cli)) {
    // The QA kit's atag.sh, in the run directory.
    const wrapper = join(runDir, "atag.sh");
    writeFileSync(wrapper, `#!/bin/sh\nexec ${shQuote(process.execPath)} --enable-source-maps ${shQuote(cli)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    return wrapper;
  }
  die(
    `no agent to run. Build the bundle first (repo root): npm run build && npm run bundle:sea && npm run bundle:fetch-assets `
    + `&& npm run bundle:build-binary && npx tsx scripts/package-bundle.ts ${bundleSlug()}, or pass --agent-bin.`,
  );
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/* --------------------------------------------------------- electron bin --- */

function electronBinary() {
  // The same lookup desktop/scripts/ensure-electron.mjs does. Not
  // node_modules/.bin/electron: on Windows that is a .cmd shim.
  const dir = join(DESKTOP, "node_modules", "electron");
  const pathFile = join(dir, "path.txt");
  if (!existsSync(pathFile)) die("electron is not installed in desktop/node_modules (run `npm ci` in desktop/)");
  const bin = join(dir, "dist", readFileSync(pathFile, "utf8").trim());
  if (!existsSync(bin)) die(`electron binary missing: ${bin} (run \`node desktop/scripts/ensure-electron.mjs\`)`);
  return bin;
}

/* ------------------------------------------------------- process trees --- */

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (WIN) {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    spawnSync(join(sysRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

/* ----------------------------------------------------- log collection --- */

const LOG_FILE = /\.log(\.\d+)?$/i;
const MAX_COPY = 20 * 1024 * 1024;

function walk(dir, visit, depth = 0) {
  if (depth > 8 || !existsSync(dir)) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(p, visit, depth + 1);
    else if (e.isFile()) visit(p);
  }
}

function copyScrubbedTail(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const size = statSync(src).size;
  let text = readFileSync(src, "utf8");
  if (size > MAX_COPY) text = `[… first ${size - MAX_COPY} bytes cut …]\n` + text.slice(-MAX_COPY);
  writeFileSync(dest, scrub(text));
}

function collectArtifacts(run, artifacts) {
  const copied = [];
  // Every log under the agent's state dir: agent.log (+ .1), the model
  // server's logs, download logs. Text only: config.json, .env and the
  // sqlite stores are never copied.
  walk(run.state, (p) => {
    if (!LOG_FILE.test(p)) return;
    const dest = join(artifacts, "state", relative(run.state, p));
    try { copyScrubbedTail(p, dest); copied.push(dest); } catch { /* locked or gone */ }
  });
  // The full suite's closing screenshot, written to the app's temp dir.
  walk(run.tmp, (p) => {
    if (!/atomic-desktop-smoke\.png$/.test(p)) return;
    try { copyFileSync(p, join(artifacts, basename(p))); copied.push(p); } catch { /* ignore */ }
  });
  // Crash dumps from Electron's crashpad, if the app crashed.
  walk(run.profile, (p) => {
    if (!/\.dmp$/i.test(p) || statSync(p).size > MAX_COPY) return;
    const dest = join(artifacts, "crashpad", basename(p));
    try { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(p, dest); copied.push(dest); } catch { /* ignore */ }
  });
  return copied;
}

/* ---------------------------------------------------------------- main --- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const known = loadKnown(opts.knownFailures);

  const outRoot = opts.out
    ? (isAbsolute(opts.out) ? opts.out : resolve(opts.out))
    : join(tmpdir(), `atomic-agent-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const run = {
    root: outRoot,
    home: join(outRoot, "home"),
    appData: join(outRoot, "home", "AppData", "Roaming"),
    localAppData: join(outRoot, "home", "AppData", "Local"),
    tmp: join(outRoot, "tmp"),
    state: join(outRoot, "state"),
    workspace: join(outRoot, "workspace"),
    profile: join(outRoot, "chromium-profile"),
  };
  const artifacts = join(outRoot, "artifacts");
  for (const d of [run.root, run.home, run.appData, run.localAppData, run.tmp, run.state, run.workspace, run.profile, artifacts]) {
    mkdirSync(d, { recursive: true });
  }
  if (opts.seed) {
    const seed = resolve(opts.seed);
    if (!existsSync(seed)) die(`seed dir not found: ${seed}`);
    cpSync(seed, run.state, { recursive: true });
  }
  if (!WIN) chmodSync(run.state, 0o700);

  if (!existsSync(join(DESKTOP, "out", "main", "main.js"))) die("desktop/out/main/main.js is missing (run `npm run build` in desktop/ first)");
  const agentBin = resolveAgentBin(opts, run.root);
  const electron = electronBinary();

  // Isolation. HOME is what the agent and the desktop's homedir() read on
  // macOS/Linux; on Windows homedir() reads USERPROFILE, and the agent's
  // Windows paths read APPDATA/LOCALAPPDATA. Temp goes inside the run too,
  // so the app's scratch files and the closing screenshot stay with it.
  const env = {
    ...process.env,
    HOME: run.home,
    USERPROFILE: run.home,
    APPDATA: run.appData,
    LOCALAPPDATA: run.localAppData,
    TMPDIR: run.tmp,
    TMP: run.tmp,
    TEMP: run.tmp,
    ATOMIC_AGENT_STATE_DIR: run.state,
    ATOMIC_AGENT_WORKSPACE: run.workspace,
    ATOMIC_AGENT_BIN: agentBin,
  };
  // Set in a shell, this one would start Electron as plain Node and no
  // window would open. (Analytics already count a --smoke run as test
  // traffic: desktop/main/analytics/environment.ts.)
  delete env.ELECTRON_RUN_AS_NODE;

  const logPath = join(artifacts, "smoke.log");
  const log = createWriteStream(logPath);
  const say = (line) => { const s = scrub(line); process.stdout.write(s + "\n"); log.write(s + "\n"); };

  const agentVersion = spawnSync(agentBin, ["--version"], { env, encoding: "utf8", timeout: 60_000 });
  const electronVersion = (() => { try { return JSON.parse(readFileSync(join(DESKTOP, "node_modules", "electron", "package.json"), "utf8")).version; } catch { return "?"; } })();
  say(`smoke-ci: tasks=${opts.tasks} platform=${process.platform}-${process.arch} node=${process.version} electron=${electronVersion}`);
  say(`smoke-ci: agent=${agentBin} (${(agentVersion.stdout || agentVersion.stderr || `exit ${agentVersion.status}`).trim().split(/\r?\n/)[0]})`);
  say(`smoke-ci: run dir=${run.root}`);
  say(`smoke-ci: known failures=${opts.knownFailures ? `${known.length} entries from ${opts.knownFailures}` : "none"}`);

  if (opts.startModel) {
    const st = spawnSync(agentBin, ["models", "start"], { env, encoding: "utf8", timeout: 10 * 60_000 });
    say(`smoke-ci: models start → exit ${st.status}: ${((st.stdout || "") + (st.stderr || "")).trim().split(/\r?\n/).pop() ?? ""}`);
  }

  const flags = opts.tasks === "full" ? [] : opts.tasks === "fusion" ? ["--smoke-fusion"] : [`--smoke-task=${opts.tasks}`];
  const args = [".", "--smoke", ...flags, `--user-data-dir=${run.profile}`, ...opts.electronArgs];
  say(`smoke-ci: ${electron} ${args.join(" ")}`);

  const started = Date.now();
  const child = spawn(electron, args, {
    cwd: DESKTOP,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on POSIX, so a timeout can end the app and
    // everything it started. On Windows detached would open a console;
    // taskkill /T walks the tree instead.
    detached: !WIN,
    windowsHide: false,
  });

  const passes = [];
  const fails = [];
  let summary = null;
  const onLine = (line) => {
    const clean = line.replace(/\r$/, "");
    say(clean);
    if (clean.startsWith("PASS ")) passes.push(clean.slice(5));
    else if (clean.startsWith("FAIL ")) fails.push(clean.slice(5));
    else if (clean.startsWith("SMOKE ")) summary = clean;
  };
  const lineReader = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    stream.on("end", () => { if (buf) onLine(buf); buf = ""; });
  };
  lineReader(child.stdout);
  lineReader(child.stderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    say(`smoke-ci: the app did not finish within ${opts.timeoutMin} min; ending it`);
    killTree(child);
  }, opts.timeoutMin * 60_000);
  const onSignal = () => { killTree(child); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  /* 'exit', not 'close': a process the app left behind may still hold the
     pipes it inherited, and 'close' would wait for it. The tail of the
     output is given a moment to drain. */
  const exitCode = await new Promise((res) => {
    child.on("error", (err) => { say(`smoke-ci: could not start electron: ${err.message}`); res(-1); });
    child.on("exit", (code, signal) => res(code ?? (signal ? `signal ${signal}` : -1)));
  });
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 1500));
  child.stdout.destroy();
  child.stderr.destroy();

  // As smoke.sh: whatever model server the run started goes too.
  spawnSync(agentBin, ["models", "stop"], { env, stdio: "ignore", timeout: 60_000 });

  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const unexpected = [];
  const knownHit = [];
  for (const f of fails) {
    const k = knownEntryFor(known, f);
    if (k) { k.hits++; knownHit.push(f); } else unexpected.push(f);
  }
  const stale = known.filter((k) => k.hits === 0).map((k) => k.entry);

  let verdict;
  let code;
  if (timedOut || summary === null || passes.length + fails.length === 0) {
    verdict = timedOut ? "TIMED OUT" : summary === null ? "DID NOT FINISH (no SMOKE summary line: the app crashed or exited early)" : "NO CHECKS RAN";
    code = 2;
  } else if (unexpected.length > 0) {
    verdict = `${unexpected.length} UNEXPECTED FAILURE(S)`;
    code = 1;
  } else {
    verdict = "OK";
    code = 0;
  }

  say("");
  say(`smoke-ci: app exit ${exitCode} after ${minutes} min · PASS ${passes.length} FAIL ${fails.length} (known ${knownHit.length}, unexpected ${unexpected.length}) · ${verdict}`);
  for (const f of unexpected) say(`smoke-ci: UNEXPECTED FAIL ${f}`);
  if (stale.length) say(`smoke-ci: ${stale.length} known-failure entr${stale.length === 1 ? "y" : "ies"} did not fire this run (fixed, not run, or renamed): ${stale.join(" | ")}`);
  await new Promise((r) => log.end(r));

  const copied = collectArtifacts(run, artifacts);
  const report = {
    tasks: opts.tasks, platform: `${process.platform}-${process.arch}`, appExit: exitCode, minutes: Number(minutes),
    verdict, exitCode: code, summary, pass: passes.length, fail: fails.length,
    unexpected, known: knownHit, staleKnownEntries: stale, agentBin, runDir: run.root, collected: copied.map((p) => relative(outRoot, p)),
  };
  writeFileSync(join(artifacts, "summary.json"), scrub(JSON.stringify(report, null, 2)) + "\n");

  if (process.env.GITHUB_ACTIONS === "true") {
    const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    for (const f of unexpected.slice(0, 50)) process.stdout.write(`::error title=desktop smoke (${process.platform})::${esc(scrub(f))}\n`);
    if (code === 2) process.stdout.write(`::error title=desktop smoke (${process.platform})::${esc(verdict)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const md = [
        `### Desktop smoke · ${process.platform}-${process.arch} · tasks \`${opts.tasks}\``,
        "",
        `**${verdict}** · PASS ${passes.length} · FAIL ${fails.length} (known ${knownHit.length}, unexpected ${unexpected.length}) · ${minutes} min · app exit ${exitCode}`,
        "",
        ...(unexpected.length ? ["#### Unexpected failures", "", ...unexpected.map((f) => `- ${scrub(f).replace(/\|/g, "\\|")}`), ""] : []),
        ...(knownHit.length ? ["<details><summary>Known failures that fired (" + knownHit.length + ")</summary>", "", ...knownHit.map((f) => `- ${scrub(f)}`), "", "</details>", ""] : []),
        ...(stale.length ? ["<details><summary>Known-failure entries that did not fire (" + stale.length + ")</summary>", "", ...stale.map((s) => `- \`${s}\``), "", "</details>", ""] : []),
      ].join("\n");
      try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* not fatal */ }
    }
  }
  process.exit(code);
}

main().catch((err) => die(err && err.stack ? err.stack : String(err), 2));
