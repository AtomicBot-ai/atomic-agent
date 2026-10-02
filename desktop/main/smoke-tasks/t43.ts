/**
 * Release-fix checks for ATO-123 (backlog «Позже: автоперезапуск», item 43
 * in the smoke). Run alone with `--smoke --smoke-task=43`.
 *
 * The local model server came up, closed twelve seconds later, and came back
 * only three minutes after that; a message sat out the agent's backoff for
 * ninety seconds until it was cancelled, and the app never started the
 * server again nor said it was down. The app now brings the server back when
 * it dies under a route that needs it — only a server the app brought up,
 * never one it stopped on purpose, never under a start or an update, and not
 * a fourth time when it dies within a minute three times in a row — and the
 * waiting strip says so.
 *
 *   A — the rules, on the supervisor class itself with stand-in looks and
 *       restarts and a clock the check moves (daemon-supervisor.ts).
 *   B — the app's own supervisor (daemon-watch.ts) against a stand-in model
 *       server: Settings' Start and Stop through the real IPC, the server
 *       killed by hand, the config's route and `autoRestart`, the agent's
 *       `provider_waiting` frame, a server Start finds already running, and
 *       the llama.cpp update (which stops the server itself). As T31 does, a
 *       guard in front of the agent binary answers `models
 *       start|stop|status|update` with a stand-in llama-server on a port of
 *       its own and writes each verb down; it is in place before anything is
 *       written, so no cleanup can reach this run's own model server. The
 *       config is pointed at that port and at the guard's directory as the
 *       managed data dir, and put back after.
 *   C — the window's words: the waiting strip and Settings › Models, with the
 *       app line and the console put back as they were.
 *
 * The supervisor is armed only inside these checks: a smoke run leaves it off
 * (T30/T31 kill model servers by hand and assert what happens next).
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configGet, configSetWhole, type UserConfigShape } from "../agent-cli.js";
import { commandOf, resolveBinary } from "../agent-client.js";
import { bringUpInFlight, supersedeBringUp } from "../backend-switch.js";
import {
  DaemonSupervisor,
  MAX_QUICK_DEATHS,
  type DaemonLook,
  type SupervisorNotice,
} from "../daemon-supervisor.js";
import { daemonWatch, hostDaemonWatch, onAgentFrame } from "../daemon-watch.js";

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
const threw = (err: unknown) => `threw: ${err instanceof Error ? err.message : String(err)}`;
const kinds = (ns: SupervisorNotice[]) => ns.map((n) => n.kind);
const alive = (pid: number) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
/** A signal to a stand-in — never to pid 0 or 1, which would reach this app's own process group, or launchd. */
const signal = (pid: number, sig: NodeJS.Signals) => { if (pid > 1) { try { process.kill(pid, sig); } catch { /* gone */ } } };
async function until(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await wait(100);
  }
  return !!(await pred());
}

/* ---- A: the rules ---- */

function standInSupervisor() {
  let clock = 1_000_000;
  const f = {
    wanted: true,
    look: "up" as DaemonLook,
    restarts: 0,
    answer: { ok: true } as { ok: boolean; superseded?: boolean; error?: string },
    during: null as null | (() => void),
    notices: [] as SupervisorNotice[],
  };
  const sv = new DaemonSupervisor({
    wanted: () => f.wanted,
    look: async () => f.look,
    restart: async () => {
      f.restarts += 1;
      f.during?.();
      return f.answer;
    },
    notify: (n) => f.notices.push(n),
    say: () => {},
    describeFault: () => "stand-in fault",
    now: () => clock,
  });
  // Armed, with a timer that never fires while the check runs: the check takes every look itself.
  const disarm = sv.arm(3_600_000);
  return { sv, f, later: (ms: number) => { clock += ms; }, disarm };
}

async function rules(check: Check): Promise<void> {
  // A1: a server the app brought up, on a route that needs it, seen down on two looks: brought back, once.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    later(120_000);
    f.look = "down";
    await sv.tick();
    const afterOne = f.restarts;
    await sv.tick();
    disarm();
    check(
      "T43 A: a server the app brought up, seen down on two looks in a row, is brought back — once, and the window is told it is restarting, then back",
      afterOne === 0 && f.restarts === 1 && JSON.stringify(kinds(f.notices)) === JSON.stringify(["restarting", "restarted"]),
      JSON.stringify({ afterOne, restarts: f.restarts, notices: kinds(f.notices) }),
    );
  }
  // A2: stopped on purpose, or a route that does not need it: never.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    sv.noteStopped();
    later(120_000);
    f.look = "down";
    for (let i = 0; i < 4; i++) await sv.tick();
    const afterStop = f.restarts;
    sv.noteStarted();
    f.wanted = false;
    for (let i = 0; i < 4; i++) await sv.tick();
    await sv.checkNow("refused");
    disarm();
    check(
      "T43 A: a server stopped on purpose (Stop, a switch, a model change) or on a route that does not need it is never brought back",
      afterStop === 0 && f.restarts === 0,
      JSON.stringify({ afterStop, restarts: f.restarts }),
    );
  }
  // A3: busy (a start, a load, an update) counts no dead look.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    later(120_000);
    f.look = "down";
    await sv.tick();
    f.look = "busy";
    for (let i = 0; i < 4; i++) await sv.tick();
    const whileBusy = f.restarts;
    f.look = "down";
    await sv.tick();
    const oneLook = f.restarts;
    await sv.tick();
    disarm();
    check(
      "T43 A: nothing is restarted while a start, a model load or a llama.cpp update is on its way, and the looks before it do not count",
      whileBusy === 0 && oneLook === 0 && f.restarts === 1,
      JSON.stringify({ whileBusy, oneLook, restarts: f.restarts }),
    );
  }
  // A4: the agent's refused connection is the second witness.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    later(120_000);
    f.look = "down";
    const back = await sv.checkNow("the agent could not reach the local model server");
    disarm();
    check(
      "T43 A: when the agent reports the server refusing connections, one look and the restart starts at once",
      back === true && f.restarts === 1,
      JSON.stringify({ back, restarts: f.restarts, notices: kinds(f.notices) }),
    );
  }
  // A5: three quick deaths in a row, and it stops trying, says so, and listens again after a start.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    f.look = "down";
    for (let i = 0; i < MAX_QUICK_DEATHS; i++) {
      later(5_000);
      await sv.checkNow("refused");
    }
    const gaveUp = sv.state().gaveUp;
    const restartsBefore = f.restarts;
    later(5_000);
    await sv.checkNow("refused");
    const afterGivingUp = f.restarts;
    sv.noteStarted();
    const listening = !sv.state().gaveUp;
    later(120_000);
    await sv.checkNow("refused");
    disarm();
    const last = f.notices.filter((n) => n.kind === "gave_up").pop();
    check(
      `T43 A: a server that dies within a minute of starting ${MAX_QUICK_DEATHS} times in a row is not restarted again, the notice says so, and a start by the person listens again`,
      gaveUp && restartsBefore === MAX_QUICK_DEATHS - 1 && afterGivingUp === restartsBefore && listening
        && f.restarts === restartsBefore + 1 && !!last && last.kind === "gave_up" && last.fault === "stand-in fault"
        && kinds(f.notices).includes("clear"),
      JSON.stringify({ gaveUp, restartsBefore, afterGivingUp, listening, restarts: f.restarts, notices: kinds(f.notices) }),
    );
  }
  // A6: a stop while it restarts: the stop's is the last word.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    later(120_000);
    f.look = "down";
    f.during = () => sv.noteStopped();
    f.answer = { ok: false, superseded: true };
    const back = await sv.checkNow("refused");
    f.during = null;
    for (let i = 0; i < 3; i++) await sv.tick();
    disarm();
    check(
      "T43 A: a stop made while it restarts wins — no \"back\", no second try, and the incident is cleared",
      back === false && f.restarts === 1 && !sv.state().owned && !kinds(f.notices).includes("restarted")
        && kinds(f.notices).includes("clear") && sv.state().incident === null,
      JSON.stringify({ back, restarts: f.restarts, notices: kinds(f.notices), state: sv.state() }),
    );
  }
  // A7: the route moves on with no stop on purpose (a cloud switch over a server already down): the incident closes.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    later(120_000);
    f.look = "down";
    f.answer = { ok: false, error: "stand-in start failed" };
    await sv.checkNow("refused");
    const open = sv.state().incident?.kind ?? null;
    f.wanted = false;
    await sv.tick();
    disarm();
    check(
      "T43 A: an incident still open when the route stops needing the server, with no stop on purpose, is closed — the window stops saying \"trying again\"",
      open === "restart_failed" && sv.state().incident === null && kinds(f.notices).at(-1) === "clear",
      JSON.stringify({ open, notices: kinds(f.notices), state: sv.state() }),
    );
  }
  // A8: the person's own start starts the count of quick deaths afresh.
  {
    const { sv, f, later, disarm } = standInSupervisor();
    sv.noteStarted();
    f.look = "down";
    for (let i = 0; i < MAX_QUICK_DEATHS - 1; i++) {
      later(5_000);
      await sv.checkNow("refused");
    }
    const counted = sv.state().quickDeaths;
    sv.noteStarted();
    const afresh = sv.state().quickDeaths;
    later(5_000);
    await sv.checkNow("refused");
    disarm();
    check(
      "T43 A: a start the person makes counts quick deaths afresh — the next quick death is restarted, not the last straw",
      counted === MAX_QUICK_DEATHS - 1 && afresh === 0 && !sv.state().gaveUp && f.restarts === MAX_QUICK_DEATHS,
      JSON.stringify({ counted, afresh, restarts: f.restarts, state: sv.state() }),
    );
  }
}

/* ---- B: the app's own supervisor against a stand-in model server ---- */

/* llama-server, as far as the desktop can tell: /health and /v1/models; it exits on SIGTERM. */
const STAND_IN = `const http = require("http");
const port = Number(process.argv[2]);
http.createServer((req, res) => {
  res.writeHead(200, {"content-type": "application/json"});
  res.end(req.url === "/v1/models" ? '{"data":[{"id":"smoke-t43-model"}]}' : '{"status":"ok"}');
}).listen(port, "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`;

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});
/* Below the ephemeral range, as T31's: a closed port must read as refused, never as another run's `atag serve`. */
async function standInPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    if (await portFree(port)) return port;
  }
  throw new Error("no free port for the stand-in");
}
async function health(port: number): Promise<number | "refused" | "silent"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch (err) {
    return (err as { cause?: { code?: unknown } }).cause?.code === "ECONNREFUSED" ? "refused" : "silent";
  }
}

async function wiring(js: Js, check: Check): Promise<void> {
  const realBin = resolveBinary();
  const live = (await configGet()).config as UserConfigShape | undefined;
  if (!realBin || !live) {
    check("T43 B: the checks ran against a guarded agent", false, !live ? "config not read" : "no agent binary");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aa-t43-"));
  const script = join(dir, "llama-server-stand-in.cjs");
  writeFileSync(script, STAND_IN);
  const port = await standInPort();
  const pidFile = join(dir, "llama-server.pid");
  const log = join(dir, "verbs.log");
  const spawnedLog = join(dir, "spawned.log");
  const updateMode = join(dir, "update-mode");
  writeFileSync(log, "");
  writeFileSync(spawnedLog, "");
  const guard = join(dir, "atag-t43-guard.sh");
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models start") echo "models start begin" >> ${q(log)}`,
    `    ELECTRON_RUN_AS_NODE=1 ${q(process.execPath)} ${q(script)} ${port} </dev/null >/dev/null 2>&1 &`,
    `    p=$!; echo "$p" > ${q(pidFile)}; echo "$p" >> ${q(spawnedLog)}`,
    `    n=0; while [ $n -lt 50 ]; do curl -s -o /dev/null http://127.0.0.1:${port}/health && break; sleep 0.1; n=$((n+1)); done`,
    `    echo "chat: started pid $p, healthy on port ${port}"; echo "models start end" >> ${q(log)}; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; p=$(cat ${q(pidFile)} 2>/dev/null); [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; rm -f ${q(pidFile)}; exit 0;;`,
    `  "models status") p=$(cat ${q(pidFile)} 2>/dev/null)`,
    `    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then printf 'mode:           managed\\ndaemon:         running (pid %s)  http://127.0.0.1:${port}\\nhealth:         ok\\n' "$p"`,
    `    else printf 'mode:           managed\\ndaemon:         stopped\\nhealth:         down\\n'; fi; exit 0;;`,
    // The llama.cpp update, as the CLI's: it stops the model server to replace the binary and never starts it again.
    `  "models update") echo "models update" >> ${q(log)}; m=$(cat ${q(updateMode)} 2>/dev/null)`,
    `    if [ "$m" = "ok" ] || [ "$m" = "fail" ]; then p=$(cat ${q(pidFile)} 2>/dev/null); [ -n "$p" ] && kill -TERM "$p" 2>/dev/null; rm -f ${q(pidFile)}; fi`,
    `    if [ "$m" = "ok" ]; then echo "backend:        updated b1 → b2"; exit 0; fi`,
    `    if [ "$m" = "fail" ]; then echo "the llama.cpp download failed" >&2; exit 1; fi`,
    `    echo "refused models update" >> ${q(log)}; exit 1;;`,
    `  "models pull"|"models pull-embedding") echo "refused $1 $2" >> ${q(log)}; exit 1;;`,
    "esac",
    `exec ${q(realBin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  const verbs = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const starts = () => verbs().filter((v) => v === "models start begin").length;
  const serverPid = () => { try { return Number(readFileSync(pidFile, "utf8").trim()) || 0; } catch { return 0; } };
  const spawned = () => readFileSync(spawnedLog, "utf8").split("\n").map(Number).filter((p) => p > 1);
  /** SIGKILL to a stand-in of this check, and to nothing else: a pid is only signalled while its command line runs this check's script. */
  const killStandIn = (pid: number) => {
    const command = alive(pid) ? commandOf(pid) : null;
    if (command && command.includes(script)) signal(pid, "SIGKILL");
  };
  const byHand = async () => {
    const pid = serverPid();
    killStandIn(pid);
    await until(async () => (await health(port)) === "refused" && !alive(pid), 5_000);
    return pid;
  };
  /** A fresh stand-in serving on the port again, other than `old`. */
  const backAfter = (old: number, ms: number) => until(async () => {
    const pid = serverPid();
    return pid !== 0 && pid !== old && alive(pid) && (await health(port)) === 200;
  }, ms);

  /* The route that needs the server: Local models (or, `cloud`, a cloud
     provider's), the managed mode, a catalogue model — the agent's config
     refuses an id it does not know — the stand-in's port, and the guard's
     directory as the managed data dir, whose pid file the supervisor reads.
     A cloud entry is always there, so a wait on it is a wait on a provider
     the config has. */
  const modelId = live.localModels?.managed?.modelId || "qwen-3.5-4b";
  const wanted = (autoRestart: boolean, cloud = false): UserConfigShape => {
    const cfg = JSON.parse(JSON.stringify(live)) as UserConfigShape;
    const lm = cfg.localModels ?? {};
    const llm = cfg.llm ?? {};
    const providers = (llm.providers ?? []).filter((p) => p.id !== "smoke-t43-cloud");
    const next = {
      ...cfg,
      localModels: {
        ...lm,
        mode: "managed",
        managed: { ...(lm.managed ?? {}), modelId, port, dataDirOverride: dir, autoRestart },
      },
      llm: {
        ...llm,
        activeTextProvider: cloud ? "smoke-t43-cloud" : "local-llama",
        providers: [
          ...(providers.some((p) => p.id === "local-llama") ? providers : [...providers, { id: "local-llama", kind: "llama-server" }]),
          { id: "smoke-t43-cloud", kind: "openai-compatible", defaultChatModel: "smoke-t43-chat" },
        ],
        runMode: { mode: cloud ? "cloud" : "local" },
      },
    };
    return next as unknown as UserConfigShape;
  };
  const write = async (cfg: UserConfigShape) => {
    const w = await configSetWhole(cfg);
    if (!w.ok) throw new Error(`the config was not written: ${w.error ?? "no reason given"}`);
  };

  const notices: SupervisorNotice[] = [];
  const keepBin = process.env.ATOMIC_AGENT_BIN;
  let guarded = false;
  let undoHost: (() => void) | null = null;
  let disarm: () => void = () => {};
  try {
    /* The guard first: from here on every `atag` call this window makes goes
       through it, the config writes below included, so nothing a failure
       leaves to the cleanup can reach this run's own model server. */
    process.env.ATOMIC_AGENT_BIN = guard;
    guarded = true;
    if (resolveBinary() !== guard) throw new Error(`the guard is not the binary main runs (${resolveBinary()})`);
    await write(wanted(true));
    // The notices are collected here and not sent on: the window's own words are C's.
    const prev = hostDaemonWatch({ notify: () => {}, say: () => {}, busy: () => false });
    hostDaemonWatch({ ...prev, notify: (n) => { notices.push(n); } });
    undoHost = () => { hostDaemonWatch(prev); };

    // B1-B2: Settings' Start, the server killed by hand, and the app brings it back.
    const started = await js<{ ok?: boolean; error?: string }>("window.atomic.modelsStart()");
    const first = serverPid();
    const owned = daemonWatch.state().owned;
    disarm = daemonWatch.arm(1_000);
    const killed = await byHand();
    const back = await backAfter(killed, 20_000);
    await until(() => kinds(notices).includes("restarted"), 5_000);
    check(
      "T43 B: a model server the app started and that was then killed by hand is brought back by the app, with a notice for the window",
      started?.ok === true && owned && first > 1 && killed === first && back && starts() === 2
        && kinds(notices).includes("restarting") && kinds(notices).includes("restarted"),
      `start ${JSON.stringify(started)}; owned ${owned}; first pid ${first}; now ${serverPid()} (${await health(port)}); starts ${starts()}; notices ${JSON.stringify(kinds(notices))}; verbs ${JSON.stringify(verbs())}`,
    );

    // B3: Settings' Stop is never fought.
    const stop = await js<{ ok?: boolean }>("window.atomic.modelsStop()");
    const before3 = starts();
    await wait(4_500);
    check(
      "T43 B: after Settings' Stop the model server stays stopped — the app does not start it again",
      stop?.ok === true && starts() === before3 && (await health(port)) === "refused" && !daemonWatch.state().owned,
      `stop ${JSON.stringify(stop)}; starts ${before3} → ${starts()}; port ${await health(port)}; state ${JSON.stringify(daemonWatch.state())}`,
    );

    // B4: autoRestart off, and a route on the cloud: a server killed by hand stays down.
    await write(wanted(false));
    await js("window.atomic.modelsStart()");
    await byHand();
    const before4 = starts();
    await wait(4_500);
    const offStarts = starts() - before4;
    await write(wanted(true, true));
    await js("window.atomic.modelsStart()");
    await byHand();
    const before4b = starts();
    await wait(4_500);
    const cloudStarts = starts() - before4b;
    check(
      "T43 B: with localModels.managed.autoRestart off, or with the route on the cloud, a server that dies stays down",
      offStarts === 0 && cloudStarts === 0,
      JSON.stringify({ offStarts, cloudStarts, verbs: verbs().slice(-8) }),
    );

    // B5: the agent's refusal brings it back at once — with the looks every minute, only the frame can.
    await write(wanted(true));
    await js("window.atomic.modelsStart()");
    disarm();
    disarm = daemonWatch.arm(60_000);
    const killed5 = await byHand();
    const before5 = starts();
    onAgentFrame({ kind: "provider_waiting", payload: { provider_id: "smoke-t43-cloud", cause: { kind: "refused" } } });
    onAgentFrame({ kind: "provider_waiting", payload: { provider_id: "local-llama", cause: { kind: "timeout" } } });
    await wait(2_500);
    const notOurs = starts() - before5;
    const t5 = Date.now();
    onAgentFrame({ kind: "provider_waiting", payload: { provider_id: "local-llama", cause: { kind: "refused" } } });
    const fast = await backAfter(killed5, 15_000);
    check(
      "T43 B: the agent waiting on the local server because it refuses connections brings it back at once — a wait on a cloud provider, or for another cause, does not",
      notOurs === 0 && fast && starts() === before5 + 1,
      `starts for the other frames ${notOurs}; back ${fast} after ${Date.now() - t5} ms; verbs ${JSON.stringify(verbs().slice(-6))}`,
    );
    await until(() => !bringUpInFlight(), 10_000);

    // B6: a server the app finds up when it asks for one is the app's to bring back, as one it started.
    disarm();
    disarm = daemonWatch.arm(1_000);
    await js("window.atomic.modelsStop()");
    const own6 = spawnByHand(script, port);
    writeFileSync(pidFile, String(own6));
    writeFileSync(spawnedLog, `${readFileSync(spawnedLog, "utf8")}${own6}\n`);
    const up6 = await until(async () => (await health(port)) === 200, 10_000);
    const ownedBefore = daemonWatch.state().owned;
    const found = await js<{ ok?: boolean; alreadyRunning?: boolean; error?: string }>("window.atomic.modelsStart()");
    const ownedAfter = daemonWatch.state().owned;
    const before6 = starts();
    const killed6 = await byHand();
    const back6 = await backAfter(killed6, 20_000);
    check(
      "T43 B: a server Settings' Start finds already running becomes the app's — when it dies, the app brings it back",
      up6 && found?.ok === true && found.alreadyRunning === true && !ownedBefore && ownedAfter && back6 && starts() === before6 + 1,
      JSON.stringify({ up6, found, ownedBefore, ownedAfter, back6, starts: starts() - before6, verbs: verbs().slice(-6) }),
    );
    await until(() => !bringUpInFlight(), 10_000);

    /* B7: the llama.cpp update stops the server itself. That stop is the app's:
       no "stopped — starting it again"; a successful update starts the server
       again by itself, a failed one leaves it stopped and says so. */
    writeFileSync(updateMode, "ok");
    const seen7 = notices.length;
    const before7 = starts();
    const was7 = serverPid();
    const updated = await js<{ ok?: boolean; error?: string }>("window.atomic.modelsUpdate()");
    const back7 = await backAfter(was7, 20_000);
    await until(() => !bringUpInFlight(), 10_000);
    const quiet7 = !kinds(notices.slice(seen7)).includes("restarting");
    check(
      "T43 B: a llama.cpp update that stops the model server starts it again once it went through — quietly, as the app's own stop, not as a crash",
      updated?.ok === true && back7 && starts() === before7 + 1 && quiet7 && daemonWatch.state().owned,
      JSON.stringify({ updated, back7, starts: starts() - before7, notices: kinds(notices.slice(seen7)), state: daemonWatch.state(), verbs: verbs().slice(-6) }),
    );
    writeFileSync(updateMode, "fail");
    const seen7b = notices.length;
    const before7b = starts();
    const failed = await js<{ ok?: boolean; error?: string }>("window.atomic.modelsUpdate()");
    await wait(4_500);
    check(
      "T43 B: after a failed llama.cpp update the server it stopped stays stopped, and the update's answer says so",
      failed?.ok === false && /still stopped/.test(failed.error ?? "") && starts() === before7b
        && (await health(port)) === "refused" && !kinds(notices.slice(seen7b)).includes("restarting") && !daemonWatch.state().owned,
      JSON.stringify({ failed, starts: starts() - before7b, notices: kinds(notices.slice(seen7b)), state: daemonWatch.state() }),
    );
    rmSync(updateMode, { force: true });
  } catch (err) {
    check("T43 B: the checks ran against a guarded agent", false, threw(err));
  } finally {
    disarm();
    // Nothing the guard answers may still be on its way when the real binary is let back in.
    if (bringUpInFlight()) supersedeBringUp();
    // Through the guard only: a stop through the real agent would stop this run's own model server.
    if (guarded && resolveBinary() === guard) await js("window.atomic.modelsStop()").catch(() => undefined);
    await until(() => !bringUpInFlight(), 10_000);
    undoHost?.();
    if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
    for (const pid of spawned()) killStandIn(pid);
    const back = await configSetWhole(live);
    if (!back.ok) check("T43 B: the config the checks found was put back", false, back.error ?? "no reason given");
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A stand-in started by the check itself, detached, as a server the app did not start would be. */
function spawnByHand(script: string, port: number): number {
  const child = spawn(process.execPath, [script, String(port)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}

/* ---- C: the window's words ---- */

async function words(js: Js, check: Check): Promise<void> {
  const r = await js<Record<string, unknown>>(`(() => {
    const keep = {dw: DWATCH, mode: LLMP.mode, err: LLMP.localErr, serr: LLMP.statusErr, busy: LLMP.localBusy, at: LLMP.lastRefreshedAt,
                  text: APPSTATUS.text, tone: APPSTATUS.tone, logs: LOGS.slice(), live: WAIT !== null};
    try {
      DWATCH = null;
      const wait = {providerId: 'local-llama', cause: {kind: 'refused'}, reason: 'fetch failed'};
      const cloud = {providerId: 'openrouter', cause: {kind: 'refused'}, reason: 'fetch failed'};
      LLMP.mode = 'local'; LLMP.localErr = null; LLMP.statusErr = null; LLMP.localBusy = false; LLMP.lastRefreshedAt = Date.now();
      const plain = waitWhy(wait);
      dwatchApply({kind: 'restarting', reason: 'the local model server stopped', quickDeaths: 0});
      const restarting = waitWhy(wait), onCloud = waitWhy(cloud), restartingLine = llmStatusLine();
      LLMP.mode = 'cloud';
      const restartingOnCloudPane = llmStatusLine();
      LLMP.mode = 'local';
      dwatchApply({kind: 'gave_up', deaths: 3, fault: 'ggml_metal: out of memory'});
      const gaveUp = waitWhy(wait), gaveUpLine = llmStatusLine();
      dwatchApply({kind: 'restarted', afterMs: 9000});
      const back = waitWhy(wait), backLine = llmStatusLine();
      /* The agent's next frame on the wait ends "back — retrying": its own
         cause is the news again. Through the frame handler itself, on a turn
         id of the check's own and with no streaming row to write into, so
         nothing lands in the transcript; skipped while a turn or a real wait
         is on screen. */
      let afterFrame = null, cleared = null;
      const frameSkipped = keep.live || !!S.busy || !window.__waitFrame || !window.__waitRecover;
      if (!frameSkipped) {
        const turn = S.turnId, stream = S.streamId;
        S.turnId = 'smoke-t43-wait'; S.streamId = null;
        try {
          window.__waitFrame({attempt: 3, waited_ms: 6000, max_wait_ms: 300000, next_retry_ms: 8000, reason: 'fetch failed',
            provider_id: 'local-llama', cause: {kind: 'refused'}});
          afterFrame = waitWhy(wait);
          cleared = DWATCH === null;
          window.__waitRecover();
        } finally {
          S.turnId = turn; S.streamId = stream;
        }
      }
      return {plain, restarting, onCloud, restartingLine, restartingOnCloudPane, gaveUp, gaveUpLine, back, backLine, afterFrame, cleared, frameSkipped};
    } catch (err) {
      return {error: String(err && err.message || err)};
    } finally {
      DWATCH = keep.dw; LLMP.mode = keep.mode; LLMP.localErr = keep.err; LLMP.statusErr = keep.serr; LLMP.localBusy = keep.busy; LLMP.lastRefreshedAt = keep.at;
      // The app line and the console's record of it, as they were: what these notices said is this check's alone.
      APPSTATUS.text = keep.text; APPSTATUS.tone = keep.tone; LOGS.splice(0, LOGS.length, ...keep.logs);
      render();
    }
  })()`);
  check(
    "T43 C: while the app brings the local server back the waiting strip says so — \"the local model server stopped — starting it again\" — and only for a wait on that server",
    r.plain === "the local model server isn’t running" && r.restarting === "the local model server stopped — starting it again"
      && r.onCloud === "connection refused",
    JSON.stringify(r),
  );
  check(
    "T43 C: once the server is back the strip says \"back — retrying\" until the agent's next word on the wait, not \"isn't running\"",
    r.back === "the local model server is back — retrying"
      && (r.frameSkipped === true || (r.afterFrame === "the local model server isn’t running" && r.cleared === true)),
    JSON.stringify(r),
  );
  check(
    "T43 C: Settings › Models says when the app stopped restarting a server that kept dying, and why — on every pane, Fusion's included",
    typeof r.gaveUpLine === "string" && /not restarted automatically/.test(r.gaveUpLine) && /out of memory/.test(r.gaveUpLine)
      && typeof r.restartingLine === "string" && /starting it again/.test(r.restartingLine)
      && r.restartingOnCloudPane === r.restartingLine
      && r.backLine === "status: ready" && /keeps stopping/.test(String(r.gaveUp)),
    JSON.stringify(r),
  );
}

export async function checks43(js: Js, check: Check): Promise<void> {
  try {
    await rules(check);
  } catch (err) {
    check("T43 A: the rules ran", false, threw(err));
  }
  try {
    await words(js, check);
  } catch (err) {
    check("T43 C: the window's words were read", false, threw(err));
  }
  await wiring(js, check);
}
