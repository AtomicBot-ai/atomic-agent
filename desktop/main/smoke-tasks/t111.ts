import { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLogTag, lineLevel } from "../agent-output.js";
import { resolveBinary } from "../agent-client.js";
import {
  backendInstalled,
  modelsUpdateStream,
  STAGING_STALE_MS,
  sweepBackendStaging,
  UPDATE_FIRST_PROGRESS_MS,
  UPDATE_STALL_MS,
} from "../agent-cli.js";
import { serveWatchArgs, WATCH_SENTINEL_SOURCE, WINDOWS_GRACEFUL_MS } from "../platform.js";

/**
 * Release-fix checks for the 06.10 small desktop batch D (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=111`.
 *
 * ATO-121 — agent.log tagged every stderr line ERR: serve's lifecycle lines,
 * the desktop's own and the web search's notice too. lineLevel reads them.
 *
 * ATO-177 — on Windows the agent was ended with `taskkill /T /F` at once and
 * its shutdown never ran. It now watches a stand-in for the app
 * (`--parent-pid`), whose end asks it to close; the tree kill comes after a
 * grace. Checked: the arguments (Windows only), and the stand-in itself —
 * alive while its stdin is open, gone when it closes, as when the app ends.
 *
 * ATO-128 — the setup's llama.cpp update had no time limit, and a model start
 * waited for it. A stand-in `atag` that never shows progress, and one that
 * stalls after its first, are each stopped by the limits (shortened here); the
 * model held for it goes on only with a llama.cpp in place (keptBackend).
 *
 * ATO-129 — a stopped update's staging folder (backend.next) was left on disk.
 * The sweep, on a folder of the check's own, and the swap it puts back.
 *
 * ATO-130 — Settings said "updating…" while the update waited its turn.
 * The line follows main's phase.
 *
 * ATO-135 — a chat row said nothing of its queued messages, and a closed
 * window lost them. The row's "N queued", and main keeping the snapshot.
 *
 * ATO-183 — a steer refused after its chat's turn ended sat in the queue of
 * an idle chat. It runs at once now; with the chat's turn running it waits.
 *
 * Nothing reaches the agent and the config is not touched: the steer and the
 * next turn's chat call are answered by stand-ins on the window's own IPC
 * (proved first by a probe, as in t106), the `atag` the update runs is a
 * script of the check's own, and the window is put back as it was.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;

const PREFIX = "smoke-t111-";
const PROBE = `${PREFIX}probe`;
const A = `${PREFIX}chat-a`;
const ROW = `${PREFIX}chat-row`;
const TURN = `${PREFIX}turn-a`;
const QUIET = "smoke t111: not answered while the check runs";
const LATE = "smoke t111: a steer the ended turn refused";
const WAITS = "smoke t111: a steer the running turn refused";
const q = (v: unknown) => JSON.stringify(v);
const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The agent as this check needs it, on the window's own IPC: every steer refused, every chat call recorded. */
class StandIn {
  readonly steered: string[] = [];
  readonly chats: string[] = [];
  private readonly quiet: Handler = () => ({ ok: false, error: QUIET });
  private readonly noParked: Handler = () => ({ ok: true, data: { undelivered: [], discarded: 0 } });
  private readonly session: Handler = (_e, id) => {
    const sid = typeof id === "string" ? id : "";
    if (sid === PROBE) return { ok: true, data: { id: sid, turns: [], smokeT111: true } };
    return { ok: false, error: QUIET };
  };
  private readonly steer: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { sessionId?: unknown; text?: unknown };
    this.steered.push(`${String(p.sessionId)}: ${String(p.text)}`);
    return { ok: false, error: "session has no turn accepting steers" };
  };
  private readonly chat: Handler = (_e, payload) => {
    const p = (payload ?? {}) as { messages?: Array<{ content?: unknown }>; sessionId?: unknown };
    this.chats.push(`${String(p.sessionId)}: ${String(p.messages?.[0]?.content ?? "")}`);
    return { ok: true, turnId: `${PREFIX}turn-next-${this.chats.length}` };
  };
  private readonly cancel: Handler = () => true;

  private channels(): Array<[string, Handler]> {
    return [
      ["agent:session", this.session], ["agent:steer", this.steer], ["agent:chat", this.chat], ["agent:cancel", this.cancel],
      ["agent:contextPreview", this.quiet], ["agent:undeliveredSteers", this.noParked], ["agent:ackSteers", this.quiet],
      ["cli:traceTools", this.quiet], ["app:statPaths", this.quiet], ["cli:chatModelsList", this.quiet],
    ];
  }

  install(wins: BrowserWindow[]): void {
    for (const x of wins) for (const [ch, fn] of this.channels()) { x.webContents.ipc.removeHandler(ch); x.webContents.ipc.handle(ch, fn); }
  }

  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) for (const [ch] of this.channels()) x.webContents.ipc.removeHandler(ch);
  }
}

const KEEP = `(() => {
  window.__t111keep = {log: S.log, sessionId: S.sessionId, agentSession: S.agentSession, busy: S.busy, pending: S.pending,
    room: S.room, streamId: S.streamId, turnId: S.turnId, draft: S.draft, toasts: S.toasts.slice(),
    queued: S.queued.slice(), ahead: STEER.ahead, opening: OPENING, owed: DRAIN_OWED,
    llmMsg: LLMP.msg, llmUpdating: LLMP.updating};
  return true;
})()`;

const FORGET = String.raw`
  const mine = (x) => typeof x === 'string' && (x.indexOf('smoke-t111-') === 0 || x.indexOf('turn:smoke-t111-') === 0);
  for (const [turn, sid] of [...RUNNING]) if (mine(turn) || mine(sid)) RUNNING.delete(turn);
  for (const id of [...LIVE_TURNS.keys()]) if (mine(id)) LIVE_TURNS.delete(id);
  for (const id of [...FIRST_TURNS.keys()]) if (mine(id)) FIRST_TURNS.delete(id);
  for (const id of [...PENDING_CHATS.keys()]) if (mine(id)) PENDING_CHATS.delete(id);
  for (const key of [...QUEUES.keys()]) if (mine(key)) QUEUES.delete(key);
  const seen = Object.keys(PREFS.seen).filter(mine);
  seen.forEach((sid) => { delete PREFS.seen[sid]; });
  if (seen.length) savePrefs();
`;

const RESTORE = `(() => {
  const k = window.__t111keep; delete window.__t111keep;
  ${FORGET}
  if (k) {
    S.log = k.log; S.sessionId = k.sessionId; S.agentSession = k.agentSession; S.busy = k.busy; S.pending = k.pending;
    S.room = k.room; S.streamId = k.streamId; S.turnId = k.turnId; S.draft = k.draft; S.toasts = k.toasts; renderToasts();
    S.queued.length = 0; S.queued.push(...k.queued); STEER.ahead = k.ahead; OPENING = k.opening; DRAIN_OWED = k.owed;
    LLMP.msg = k.llmMsg; LLMP.updating = k.llmUpdating;
  }
  render();
  return true;
})()`;

/* Chat A on screen and idle: its turn has ended (the reply on screen, nothing running). */
const STAGE_IDLE = `(() => {
  ${FORGET}
  S.queued.length = 0; STEER.ahead = 0; DRAIN_OWED = false; OPENING = null;
  S.room = 'chat'; S.busy = false; S.pending = null; S.turnId = null; S.streamId = null;
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  S.log = [{id: nid(), k: 'user', text: 'smoke t111: hello'}, {id: nid(), k: 'assistant', text: 'smoke t111: hi', turn: ${q(TURN)}}];
  render();
  return true;
})()`;

/* Chat A on screen, its turn running. */
const STAGE_RUNNING = `(() => {
  ${FORGET}
  S.queued.length = 0; STEER.ahead = 0; DRAIN_OWED = false; OPENING = null;
  S.room = 'chat'; S.busy = true; S.pending = null; S.turnId = ${q(TURN)};
  S.sessionId = ${q(A)}; S.agentSession = ${q(A)};
  const item = {id: nid(), k: 'assistant', text: '', turn: ${q(TURN)}};
  S.log = [{id: nid(), k: 'user', text: 'smoke t111: hello'}, item];
  S.streamId = item.id;
  RUNNING.set(${q(TURN)}, ${q(A)});
  render();
  return true;
})()`;

/** The `atag` the update check runs: `models update` as the case asks, anything else the real agent. */
function standInAgent(dir: string, real: string | null, body: string): string {
  const path = join(dir, `atag-${Math.random().toString(36).slice(2, 8)}`);
  writeFileSync(path, [
    "#!/bin/sh",
    `if [ "$1" != "models" ] || [ "$2" != "update" ]; then ${real ? `exec ${sh(real)} "$@"` : "exit 1"}; fi`,
    body,
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return path;
}

async function updateLimits(check: Check): Promise<void> {
  check(
    "T111 (ATO-128): the setup's llama.cpp update has its own limits — 90 s to show progress, 5 min without a line once bytes move",
    UPDATE_FIRST_PROGRESS_MS === 90_000 && UPDATE_STALL_MS === 300_000,
    show({ UPDATE_FIRST_PROGRESS_MS, UPDATE_STALL_MS }),
  );
  if (process.platform === "win32") return;   // the stand-in is a shell script
  const dir = mkdtempSync(join(tmpdir(), "aa-t111-"));
  const before = process.env["ATOMIC_AGENT_BIN"];
  const real = resolveBinary();
  try {
    // (a) Never shows progress: stopped by the first limit.
    process.env["ATOMIC_AGENT_BIN"] = standInAgent(dir, real, 'echo "current: b1 → latest: b2"\nexec sleep 30');
    const lines: string[] = [];
    const t0 = Date.now();
    const silent = await modelsUpdateStream((l) => lines.push(l), { firstProgressMs: 400, stallMs: 400 }).done;
    const tookSilent = Date.now() - t0;
    const installed = backendInstalled();
    const said = installed
      ? /made no progress for 0 s and was stopped — the model starts on the llama\.cpp already installed/
      : /made no progress for 0 s and was stopped — there is no llama\.cpp installed yet/;
    check(
      "T111 (ATO-128): an update that shows no progress is stopped by its own limit and says so; the start behind it goes on only with a llama.cpp in place",
      silent.ok === false && silent.timedOut === true && silent.sawProgress === false && tookSilent < 5_000
        && silent.keptBackend === installed && said.test(String(silent.error)),
      show({ silent: { ok: silent.ok, timedOut: silent.timedOut, keptBackend: silent.keptBackend, error: silent.error }, installed, tookSilent, lines }),
    );
    // (b) Shows progress, then nothing: stopped by the stall limit.
    process.env["ATOMIC_AGENT_BIN"] = standInAgent(dir, real, 'echo "[=                   ] 5%" >&2\nexec sleep 30');
    const stalled = await modelsUpdateStream(() => {}, { firstProgressMs: 30_000, stallMs: 400 }).done;
    check(
      "T111 (ATO-128): an update whose bytes stop moving is stopped by the stall limit",
      stalled.ok === false && stalled.timedOut === true && stalled.sawProgress === true,
      show({ ok: stalled.ok, timedOut: stalled.timedOut, sawProgress: stalled.sawProgress, error: stalled.error }),
    );
    // (c) Up to date at once: no limit reached.
    process.env["ATOMIC_AGENT_BIN"] = standInAgent(dir, real, 'echo "backend up to date (b2)"\nexit 0');
    const current = await modelsUpdateStream(() => {}, { firstProgressMs: 2_000, stallMs: 2_000 }).done;
    check(
      "T111 (ATO-128): an update that is over in time is not stopped",
      current.ok === true && current.timedOut === false && current.keptBackend === false && current.upToDate === true,
      show({ ok: current.ok, timedOut: current.timedOut, upToDate: current.upToDate, error: current.error }),
    );
  } finally {
    if (before === undefined) delete process.env["ATOMIC_AGENT_BIN"];
    else process.env["ATOMIC_AGENT_BIN"] = before;
    rmSync(dir, { recursive: true, force: true });
  }
}

async function stagingSweep(check: Check): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "aa-t111-staging-"));
  try {
    const fill = (name: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "llama.zip"), "x".repeat(1024)); };
    // (a) A stopped update's leftovers beside a live backend: both go.
    fill("backend"); fill("backend.next"); fill("backend.old");
    const swept = await sweepBackendStaging(dir);
    const left = { next: existsSync(join(dir, "backend.next")), old: existsSync(join(dir, "backend.old")), live: existsSync(join(dir, "backend")) };
    // (b) backend.old with no live backend/ beside it — a swap killed between its renames — is moved back.
    rmSync(join(dir, "backend"), { recursive: true, force: true });
    fill("backend.old");
    const lone = await sweepBackendStaging(dir);
    const loneKept = existsSync(join(dir, "backend", "llama.zip")) && !existsSync(join(dir, "backend.old"));
    // (c) At launch: one written a moment ago may be a download on its way and stays; a stale one goes.
    fill("backend.next");
    const fresh = await sweepBackendStaging(dir, { minAgeMs: STAGING_STALE_MS });
    const freshKept = existsSync(join(dir, "backend.next"));
    const old = (Date.now() - STAGING_STALE_MS - 60_000) / 1000;
    utimesSync(join(dir, "backend.next", "llama.zip"), old, old);
    utimesSync(join(dir, "backend.next"), old, old);
    const stale = await sweepBackendStaging(dir, { minAgeMs: STAGING_STALE_MS });
    check(
      "T111 (ATO-129): a stopped update's staging folder is swept, a half-done swap put back, and at launch only once nothing wrote it for 10 min",
      show(swept) === show(["backend.next", "backend.old"]) && !left.next && !left.old && left.live
        && show(lone) === show(["backend.old → backend"]) && loneKept && fresh.length === 0 && freshKept
        && show(stale) === show(["backend.next"]) && !existsSync(join(dir, "backend.next")),
      show({ swept, left, lone, loneKept, fresh, freshKept, stale }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function sentinel(check: Check): Promise<void> {
  check(
    "T111 (ATO-177): `atag serve` watches the app's stand-in on Windows only, and a Windows stop asks the agent first for 5 s",
    show(serveWatchArgs("win32", 4242)) === show(["--parent-pid", "4242"]) && serveWatchArgs("darwin", 4242).length === 0
      && serveWatchArgs("linux", 4242).length === 0 && serveWatchArgs("win32", undefined).length === 0 && WINDOWS_GRACEFUL_MS === 5_000,
    show({ win: serveWatchArgs("win32", 4242), mac: serveWatchArgs("darwin", 4242) }),
  );
  const child = spawn(process.execPath, ["-e", WATCH_SENTINEL_SOURCE], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.on("error", () => {});
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  await wait(700);
  const aliveWhileOpen = child.exitCode === null && child.signalCode === null;
  child.stdin?.end();
  const code = await Promise.race([exited, wait(4_000).then(() => "late" as const)]);
  if (code === "late") child.kill("SIGKILL");
  check(
    "T111 (ATO-177): the stand-in the agent watches stays up while the app holds its stdin, and ends by itself when that closes",
    aliveWhileOpen && code === 0,
    show({ aliveWhileOpen, code, pid: child.pid ?? null }),
  );
}

export async function checks111(js: Js, check: Check): Promise<void> {
  // ATO-121 — main's own classification, as agent.log writes it.
  const levels = {
    listening: lineLevel("[atomic-agent] serve listening on http://127.0.0.1:5000 (auth=bearer, cwd=/Users/x/error-logs)"),
    sigterm: lineLevel("[atomic-agent] SIGTERM received, closing"),
    stopping: lineLevel("[desktop] local-llm: the app is stopping the model server (route cloud)"),
    exa: lineLevel('web.search: provider "exa" is configured but EXA_API_KEY is not set; running on the keyless tier'),
    structured: lineLevel("[2026-10-06T10:00:00.000Z] INFO tool executed"),
    failedStart: lineLevel("[desktop] could not start the local model daemon (qwen): boom"),
    crash: lineLevel("serve failed: Error: boom"),
    stack: lineLevel("    at Object.<anonymous> (/x/y.js:1:1)"),
  };
  const tags = {
    sigterm: agentLogTag("stderr", levels.sigterm), exa: agentLogTag("stderr", levels.exa),
    failedStart: agentLogTag("stderr", levels.failedStart), crash: agentLogTag("stderr", levels.crash),
  };
  check(
    "T111 (ATO-121): agent.log tags serve's lifecycle lines and the desktop's INFO, the search notice WARN, a failed start ERROR, a crash and a stack ERR",
    levels.listening === "info" && levels.sigterm === "info" && levels.stopping === "info" && levels.exa === "warn"
      && levels.structured === "info" && levels.failedStart === "error" && levels.crash === null && levels.stack === null
      && tags.sigterm === "INFO" && tags.exa === "WARN" && tags.failedStart === "ERROR" && tags.crash === "ERR",
    show({ levels, tags }),
  );

  await sentinel(check);
  await updateLimits(check);
  await stagingSweep(check);

  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const agent = new StandIn();
  let kept = false;
  try {
    agent.install(wins);
    const probe = await js<{ data?: { smokeT111?: boolean } } | null>(`BR.session(${q(PROBE)})`).catch((e: unknown) => String(e));
    if (typeof probe !== "object" || probe?.data?.smokeT111 !== true) {
      check("T111: a stand-in on the window's IPC answers the session fetch first", false, `${show(probe)}; nothing was staged`);
      return;
    }
    kept = await js<boolean>(KEEP);

    // ATO-130 — the Settings line follows main's phase while the update is on, and only then.
    const phase = await js<{ waiting: string; running: string; off: string }>(`(() => {
      LLMP.updating = true; LLMP.msg = {text: LLM_UPDATING};
      llmUpdatePhase({phase: 'waiting'});
      const waiting = LLMP.msg.text;
      llmUpdatePhase({phase: 'running'});
      const running = LLMP.msg.text;
      LLMP.updating = false; LLMP.msg = {text: 'local-llm: something else'};
      llmUpdatePhase({phase: 'waiting'});
      return {waiting, running, off: LLMP.msg.text};
    })()`);
    check(
      "T111 (ATO-130): Settings read \"waiting for the model to start\" while the update waits its turn, \"updating\" once it runs, and nothing else is overwritten",
      phase.waiting === "local-llm: llama.cpp update waiting for the model to start…"
        && phase.running === "local-llm: updating the llama.cpp backend…" && phase.off === "local-llm: something else",
      show(phase),
    );

    // ATO-135 — a row's "N queued", and main keeping the window's queues.
    const row = await js<{ html: string; snap: Record<string, string[]>; kept: Record<string, string[]>; cleared: Record<string, string[]> }>(`(() => {
      ${FORGET}
      QUEUES.set(${q(ROW)}, {queued: ['smoke t111: one', 'smoke t111: two'], ahead: 0, owed: false});
      const html = chatRow({id: ${q(ROW)}, t: 'smoke t111 row', updatedAt: 0});
      const snap = queuesSnapshot();
      queuesKeep();
      const kept = BR.queuesTake() || {};
      QUEUES.delete(${q(ROW)});
      queuesKeep();
      const cleared = BR.queuesTake() || {};
      return {html, snap, kept, cleared};
    })()`);
    check(
      "T111 (ATO-135): a chat with queued messages says \"2 queued\" on its row, and main keeps them for the next window until they go",
      row.html.includes('data-m="2 queued"') && row.html.includes("· 2 queued")
        && show(row.snap[ROW]) === show(["smoke t111: one", "smoke t111: two"])
        && show(row.kept[ROW]) === show(["smoke t111: one", "smoke t111: two"]) && !(ROW in row.cleared),
      show(row),
    );

    // ATO-183 — chat A idle on screen; a steer it refused (its turn just ended) runs at once as its next turn.
    await js<boolean>(STAGE_IDLE);
    const markChat = agent.chats.length;
    // The bench's own route (a local model it may not have downloaded) is not
    // what this checks: the start-of-turn gate is held open for the steer.
    const idle = await js<{ queued: string[]; busy: boolean; systems: string[] }>(`(async () => {
      const gateWas = localTurnGate;
      localTurnGate = () => ({kind: 'run'});
      try { await steerOrQueueRun(${q(LATE)}, null, {sid: ${q(A)}, key: ${q(A)}}); } finally { localTurnGate = gateWas; }
      return {queued: S.queued.slice(), busy: !!S.busy, systems: S.log.filter((m) => m.k === 'system').map((m) => String(m.text || ''))};
    })()`);
    for (let i = 0; i < 20 && agent.chats.length === markChat; i++) await wait(100);
    const sentIdle = agent.chats.slice(markChat);
    if (sentIdle.length) {
      await js<boolean>(`(() => { onChatEvent({turnId: ${q(`${PREFIX}turn-next-${agent.chats.length}`)}, kind: 'done', payload: {}}); return true; })()`);
    }
    check(
      "T111 (ATO-183): a steer refused after the chat's turn ended runs at once as its next turn, not left in the tray of an idle chat",
      show(agent.steered.slice(-1)) === show([`${A}: ${LATE}`]) && show(sentIdle) === show([`${A}: ${LATE}`])
        && idle.queued.length === 0 && !idle.systems.some((t) => /runs as the next turn/.test(t)),
      `idle=${show(idle)} chats=${show(agent.chats)} steered=${show(agent.steered)}`,
    );

    // …and with the chat's own turn running, a refused steer waits for that turn's end, as before.
    await js<boolean>(STAGE_RUNNING);
    const markChat2 = agent.chats.length;
    const running = await js<{ queued: string[] }>(`(async () => {
      await steerOrQueueRun(${q(WAITS)}, null, {sid: ${q(A)}, key: ${q(A)}});
      return {queued: S.queued.slice()};
    })()`);
    await wait(300);
    check(
      "T111 (ATO-183): with the chat's own turn running, a refused steer is queued for that turn's end and not sent",
      show(running.queued) === show([WAITS]) && agent.chats.length === markChat2,
      `running=${show(running)} chats=${show(agent.chats)}`,
    );
  } finally {
    /* The stand-ins come off before anything else is awaited (see t25). */
    agent.uninstall(wins);
    if (kept) await js<unknown>(RESTORE).catch(() => undefined);
    await js<unknown>("queuesKeep()").catch(() => undefined);
    await wait(50);
  }
}
