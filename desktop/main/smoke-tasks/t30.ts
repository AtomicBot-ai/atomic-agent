/**
 * Release-fix checks for backlog items 30 and 31 (see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=30` (or `=31`).
 *
 * 30 — quitting left the model server running. A second Quit while the first
 * was still stopping things (Cmd+Q again, the Dock's Quit while the window was
 * still up) found the agent already gone and let the app exit there and then,
 * before `models stop` had run. And nothing made sure a server that outlived
 * that stop (one that ignores SIGTERM) went with the app.
 *
 * 31 — a model server killed by hand was not brought back. llama-server killed
 * while a request is open on it closes its port and then waits for that
 * request for good: its pid stays alive, `models status` keeps saying
 * `running`, and Settings' Start, the launch start and a model pick all took it
 * for up; only a cloud switch, which stops first, brought the model back. Killed
 * during the speed probe of `models start`, it also held the daemon's turn for
 * the start's whole 90 s, so whatever start came next said nothing that long.
 *
 * Nothing here loads a model. A stand-in plays llama-server: a small server on
 * a free port that answers /health like it (200, or 503 while "loading"), and
 * on the first SIGTERM closes its port and stays alive, as llama-server does
 * with a request open; a second SIGTERM ends it. Its command line names
 * llama-server, as the real one's does.
 *
 * 30 runs a second window of this app (not a smoke run) on a throwaway state
 * dir, behind a guard in front of the agent binary whose `models stop` sends
 * the stand-in one SIGTERM and takes its time, and quits it twice. 31 runs in
 * this window: the guard sends `models status` and `models stop` to the real
 * agent on a throwaway state dir that names the stand-in, and `models start`
 * never reaches the agent — it starts a stand-in. The smoke's own state dir,
 * config and model server are left as they were.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

import { configGet, configSetWhole, localDaemonRunning, type UserConfigShape } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import { bringUpAtLaunch, bringUpInFlight, startDaemonNow, supersedeBringUp } from "../backend-switch.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const threw = (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`;
const MODEL = "qwen-3.5-4b";

/* llama-server, as far as the desktop can tell: /health, /v1/models, and its
   SIGTERM with a request open (the port closes, the process stays). */
const STAND_IN = `const http = require("http");
const port = Number(process.argv[2]); const mode = process.argv[3] || "ok";
const srv = http.createServer((req, res) => {
  if (mode === "loading") { res.writeHead(503, {"content-type": "application/json"}); res.end('{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'); return; }
  res.writeHead(200, {"content-type": "application/json"});
  res.end(req.url === "/v1/models" ? '{"data":[{"id":"${MODEL}"}]}' : '{"status":"ok"}');
});
const listen = () => srv.listen(port, "127.0.0.1");
if (mode === "late") setTimeout(listen, 800); else listen();
let terms = 0;
process.on("SIGTERM", () => { terms += 1; if (terms === 1) { srv.close(); srv.closeAllConnections(); } else process.exit(130); });
setInterval(() => {}, 1 << 30);
`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const a = srv.address();
      const port = typeof a === "object" && a ? a.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}
const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});
/* A stand-in's port, below the ephemeral range: once a stand-in closes its port
   the check reads it as refused, and a port the system hands out to any bind(0)
   (another run's `atag serve`) could answer there instead. */
async function standInPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (await portFree(port)) return port;
  }
  throw new Error("no free port for the stand-in");
}
const alive = (pid: number) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
/** A signal to a stand-in — never to pid 0 or 1, which would reach this app's own process group, or launchd. */
const signal = (pid: number, sig: NodeJS.Signals) => { if (pid > 1) { try { process.kill(pid, sig); } catch { /* gone */ } } };
async function health(port: number): Promise<number | "refused" | "silent"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch (err) {
    return (err as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED" ? "refused" : "silent";
  }
}
async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(100);
  }
  return !!(await pred());
}

/** A stand-in on `port`, detached (it outlives whoever started it, as a model server does). */
function standIn(script: string, port: number, mode: "ok" | "loading" | "late"): number {
  const child = spawn(process.execPath, [script, String(port), mode], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}

/* ---- 30: a second window of this app, driven over the DevTools protocol ---- */

async function cdpEval(port: number, expression: string): Promise<unknown> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
  const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) throw new Error("no page yet");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP refused")), { once: true });
    });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP timed out")), 5_000);
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (m.id !== 1) return;
        clearTimeout(timer);
        resolve(m.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
  } finally {
    try { ws.close(); } catch { /* gone */ }
  }
}

async function quitChecks(check: Check, standInScript: string, dir: string, realBin: string): Promise<void> {
  const state = join(dir, "quit-state");
  const data = join(state, "models");
  mkdirSync(data, { recursive: true });
  const port = await standInPort();
  writeFileSync(join(state, "config.json"), JSON.stringify({
    localModels: { mode: "managed", managed: { modelId: MODEL, port, stopOnExit: true } },
    tui: { onboarding: { completedAt: "2026-09-23T00:00:00.000Z" } },
  }, null, 2));
  const log = join(dir, "quit-verbs.log");
  writeFileSync(log, "");
  const guard = join(dir, "atag-quit-guard.sh");
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    // The stop a llama-server outlives: one SIGTERM, some time, and no SIGKILL.
    `  "models stop") echo "models stop begin" >> ${q(log)}`,
    `    p=$(cat ${q(join(data, "llama-server.pid"))} 2>/dev/null); [ -n "$p" ] && kill -TERM "$p" 2>/dev/null`,
    `    sleep 2; echo "models stop end" >> ${q(log)}; exit 0;;`,
    `  "models status") printf 'mode:           managed\\ndaemon:         running (pid %s)  http://127.0.0.1:${port}\\nhealth:         ok\\n' "$(cat ${q(join(data, "llama-server.pid"))} 2>/dev/null)"; exit 0;;`,
    `  "models start") echo "models start" >> ${q(log)}; exit 1;;`,
    "esac",
    `exec ${q(realBin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);

  const server = standIn(standInScript, port, "ok");
  writeFileSync(join(data, "llama-server.pid"), String(server));
  const cdp = await freePort();
  let second: ChildProcess | null = null;
  try {
    if (!(await until(async () => (await health(port)) === 200, 10_000))) {
      check("T30: the stand-in model server answers", false, `port ${port}: ${await health(port)}`);
      return;
    }
    second = spawn(process.execPath, [app.getAppPath(), `--remote-debugging-port=${cdp}`, `--user-data-dir=${join(dir, "quit-profile")}`], {
      env: { ...process.env, ATOMIC_AGENT_STATE_DIR: state, ATOMIC_AGENT_BIN: guard, ATOMIC_AGENT_WORKSPACE: dir },
      stdio: "ignore",
    });
    const proc = second;
    let exitedAt: number | null = null;
    let verbsAtExit = "";
    proc.once("exit", () => {
      exitedAt = Date.now();
      try { verbsAtExit = readFileSync(log, "utf8"); } catch { /* none */ }
    });
    // The second window is up, its agent connected (so its Quit has an agent to stop first).
    const up = await until(async () => {
      try { return (await cdpEval(cdp, "typeof window.atomic?.quit === 'function' && window.__live && window.__live()")) === "connected"; }
      catch { return false; }
    }, 60_000);
    if (!up) {
      check("T30: a second window of the app comes up for the quit checks", false, `exit ${proc.exitCode}`);
      return;
    }
    // Quit, and quit again while the first quit is still stopping things.
    void cdpEval(cdp, "window.atomic.quit(), true").catch(() => undefined);
    await wait(150);
    void cdpEval(cdp, "window.atomic.quit(), true").catch(() => undefined);
    await until(() => exitedAt !== null, 30_000);
    await wait(500);
    const stopEnded = /models stop end/.test(verbsAtExit);
    check(
      "T30: a second Quit while the first is still stopping things waits for it — the model server's stop ran to its end before the app was gone",
      exitedAt !== null && stopEnded,
      `exited ${exitedAt !== null}; verbs when the app was gone: ${JSON.stringify(verbsAtExit.split("\n").filter(Boolean))}`,
    );
    check(
      "T30: a model server that outlives the quit's stop (it ignored SIGTERM) goes with the app",
      exitedAt !== null && !alive(server),
      `stand-in pid ${server} ${alive(server) ? "STILL RUNNING" : "gone"} after the app exited; port ${port}: ${await health(port)}`,
    );
  } finally {
    if (second && second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
    signal(server, "SIGKILL");
  }
}

/* ---- 31: the daemon verdict and the daemon's turn, in this window ---- */

async function reviveChecks(js: Js, check: Check, standInScript: string, dir: string, realBin: string): Promise<void> {
  const state = join(dir, "revive-state");
  const data = join(state, "models");
  mkdirSync(data, { recursive: true });
  const port = await standInPort();
  writeFileSync(join(state, "config.json"), JSON.stringify({
    localModels: { mode: "managed", managed: { modelId: MODEL, port } },
  }, null, 2));
  const pidFile = join(data, "llama-server.pid");
  const log = join(dir, "revive-verbs.log");
  const startMode = join(dir, "start-mode");
  const guard = join(dir, "atag-revive-guard.sh");
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models start") echo "models start begin" >> ${q(log)}`,
    `    ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(standInScript)} ${port} ok </dev/null >/dev/null 2>&1 &`,
    `    echo $! > ${q(pidFile)}; echo "models start spawned" >> ${q(log)}`,
    // "hang": the speed probe that never comes back.
    `    if [ "$(cat ${q(startMode)} 2>/dev/null)" = "hang" ]; then exec sleep 60; fi`,
    `    sleep 1; echo "chat: started pid $(cat ${q(pidFile)}), healthy on port ${port}"`,
    `    echo "models start end" >> ${q(log)}; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; ATOMIC_AGENT_STATE_DIR=${q(state)} exec ${q(realBin)} "$@";;`,
    `  "models status") ATOMIC_AGENT_STATE_DIR=${q(state)} exec ${q(realBin)} "$@";;`,
    "esac",
    `exec ${q(realBin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  const verbs = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const spawned: number[] = [];
  const pidNamed = () => { try { return Number(readFileSync(pidFile, "utf8").trim()) || 0; } catch { return 0; } };
  /** A stand-in recorded as the daemon, as `models start` records the one it spawned. */
  const serve = async (mode: "ok" | "loading" | "late") => {
    const pid = standIn(standInScript, port, mode);
    spawned.push(pid);
    writeFileSync(pidFile, String(pid));
    if (mode !== "late") await until(async () => typeof (await health(port)) === "number", 10_000);
    return pid;
  };
  const clear = async () => {
    for (const pid of [...spawned, pidNamed()]) signal(pid, "SIGKILL");
    rmSync(pidFile, { force: true });
    await until(async () => (await health(port)) === "refused", 5_000);
  };
  /** Killed by hand with a request open: the port closes, the pid lives on. Answers whether it did. */
  const killByHand = async (pid: number) => {
    signal(pid, "SIGTERM");
    return (await until(async () => (await health(port)) === "refused", 5_000)) && alive(pid);
  };

  const live = (await configGet()).config as UserConfigShape | undefined;
  const keepBin = process.env.ATOMIC_AGENT_BIN;
  // Starts this check set going: all settled before the real binary is let back in.
  const pending: Array<Promise<unknown>> = [];
  if (!live) {
    check("T31: the daemon checks ran against a guarded agent", false, "config not read");
    return;
  }
  try {
    // The start watchdog reads the managed port from this window's own config: point it at the stand-in's.
    const lm = live.localModels ?? {};
    await configSetWhole({ ...live, localModels: { ...lm, managed: { ...(lm.managed ?? {}), port } } } as UserConfigShape);
    process.env.ATOMIC_AGENT_BIN = guard;

    // 1. A model that is loading (503), or a server spawned a moment ago (its port not bound yet), is not dead.
    await serve("loading");
    const loading = await localDaemonRunning();
    const loadingAlive = alive(pidNamed());
    await clear();
    await serve("late");
    const late = await localDaemonRunning();
    const lateAlive = alive(pidNamed());
    await clear();
    check(
      "T31: a model server that is loading (503), or was spawned a moment ago and has not bound its port yet, counts as up and is left alone",
      loading && loadingAlive && late && lateAlive,
      JSON.stringify({ loading, loadingAlive, late, lateAlive }),
    );

    // 2. Killed by hand mid-request: the pid lives on with its port closed.
    const wedged = await serve("ok");
    const before = await localDaemonRunning();
    const lingers = await killByHand(wedged);
    const t2 = Date.now();
    const after = await localDaemonRunning();
    const ms2 = Date.now() - t2;
    await until(() => !alive(wedged), 6_000);
    check(
      "T31: a model server alive with its port closed (killed by hand mid-request) counts as down, and is stopped",
      before === true && lingers && after === false && !alive(wedged),
      `healthy: ${before}; port closed with the pid alive: ${lingers}; after the kill: ${after} in ${ms2} ms; pid ${wedged} ${alive(wedged) ? "still alive" : "gone"}; verbs ${JSON.stringify(verbs())}`,
    );
    await clear();

    // 3. Settings' Start after such a kill brings the model server back.
    writeFileSync(log, "");
    writeFileSync(startMode, "ok");
    const wedged3 = await serve("ok");
    const lingers3 = await killByHand(wedged3);
    const started = await js<{ ok?: boolean; alreadyRunning?: boolean; error?: string }>("window.atomic.modelsStart()");
    const fresh = pidNamed();
    const answers = await health(port);
    check(
      "T31: Settings' Start brings the model server back after it was killed by hand mid-request",
      lingers3 && started?.ok === true && !started.alreadyRunning && verbs().includes("models start begin")
        && !alive(wedged3) && fresh !== wedged3 && alive(fresh) && answers === 200,
      `port closed with the pid alive: ${lingers3}; start ${JSON.stringify(started)}; old pid ${wedged3} ${alive(wedged3) ? "alive" : "gone"}; new pid ${fresh}; port ${answers}; verbs ${JSON.stringify(verbs())}`,
    );
    await clear();

    // 4. The launch start (a relaunch, a ⇄'s background start) after such a kill brings it back too.
    writeFileSync(log, "");
    const wedged4 = await serve("ok");
    const lingers4 = await killByHand(wedged4);
    const launch = await bringUpAtLaunch(MODEL);
    const fresh4 = pidNamed();
    check(
      "T31: the launch start brings the model server back after it was killed by hand mid-request",
      lingers4 && launch.daemon === "started" && !alive(wedged4) && fresh4 !== wedged4 && alive(fresh4) && (await health(port)) === 200,
      `port closed with the pid alive: ${lingers4}; launch ${JSON.stringify(launch)}; old pid ${wedged4} ${alive(wedged4) ? "alive" : "gone"}; new pid ${fresh4}; verbs ${JSON.stringify(verbs())}`,
    );
    await clear();

    // 5. Killed during the start's speed probe: the start gives the daemon's turn up within seconds, not 90 s,
    //    and the Start queued behind it brings a fresh server up.
    writeFileSync(log, "");
    writeFileSync(startMode, "hang");
    const hung = bringUpAtLaunch(MODEL);
    pending.push(hung);
    await until(() => verbs().includes("models start spawned") && alive(pidNamed()), 10_000);
    const probed = pidNamed();
    spawned.push(probed);
    await until(async () => (await health(port)) === 200, 10_000);
    await wait(700);   // the start's watch has seen it healthy
    writeFileSync(startMode, "ok");
    const queued = startDaemonNow();
    pending.push(queued);
    signal(probed, "SIGTERM");   // by hand, mid-probe
    const t5 = Date.now();
    const settled = await Promise.race([hung.then((r) => ({ r, ms: Date.now() - t5 })), wait(15_000).then(() => null)]);
    const next = settled ? await Promise.race([queued, wait(20_000).then(() => null)]) : null;
    const fresh5 = pidNamed();
    check(
      "T31: a start whose model server is killed during its speed probe gives the daemon's turn up within seconds, not after 90",
      settled !== null && settled.ms < 8_000 && settled.r.daemon === "start-failed",
      settled ? `the start ended after ${settled.ms} ms: ${JSON.stringify(settled.r)}` : "the start still held the turn 15 s after its server went",
    );
    check(
      "T31: the Start queued behind that start brings a fresh model server up",
      next !== null && next.ok === true && !next.alreadyRunning && fresh5 !== probed && alive(fresh5) && (await health(port)) === 200,
      `queued start ${JSON.stringify(next)}; probed pid ${probed} ${alive(probed) ? "alive" : "gone"}; new pid ${fresh5}; verbs ${JSON.stringify(verbs())}`,
    );
  } catch (err) {
    check("T31: the daemon checks ran against a guarded agent", false, threw(err));
  } finally {
    // A start left hanging is ended, and every start this check set going has settled, before the real binary is let back in.
    if (bringUpInFlight()) supersedeBringUp();
    const settled = await Promise.race([Promise.allSettled(pending).then(() => true), wait(30_000).then(() => false)]);
    if (settled) {
      if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
    } else {
      check("T31: no start was left running before the guard was taken away", false, "still running — the guard stays in place");
    }
    await clear().catch(() => undefined);
    await configSetWhole(live);
  }
}

export async function checks30(js: Js, check: Check): Promise<void> {
  const realBin = resolveBinary();
  if (!realBin) {
    check("T30: the agent binary is there for the checks", false, "no agent binary");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-t30-"));
  const standInScript = join(dir, "llama-server-stand-in.cjs");
  writeFileSync(standInScript, STAND_IN);
  try {
    try {
      await quitChecks(check, standInScript, dir, realBin);
    } catch (err) {
      check("T30: the quit checks ran", false, threw(err));
    }
    await reviveChecks(js, check, standInScript, dir, realBin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
