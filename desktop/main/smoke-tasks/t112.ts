import { BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type CliResult } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import { selectFusionWorkerModel, selectLocalModel, withSwitchStandIn, type SwitchResult } from "../backend-switch.js";
import { agentEnv } from "../state-dir.js";

/**
 * Release-fix checks for the 06.10 local models batch (see
 * main/release-fixes-smoke.ts). Run alone with `--smoke --smoke-task=112`.
 *
 * ATO-134 — a switch restarts the agent, and a scheduled task or a Telegram
 * reply (which the window never streams) ended with it. The switch now asks
 * main (agent:busyAnywhere, the updater's agentBusy) and, while the agent is
 * busy, keeps its lock and waits, saying so, with "Switch now anyway" and
 * Cancel, and gives up after its limit (shortened here). Main's own answer is
 * asked once; then a stand-in on the window's IPC answers instead, and the
 * switch's `run` is the check's own: nothing is switched, nothing restarts.
 *
 * ATO-127 — a Fusion worker model pick started the model the workers were
 * leaving before the one picked. Main's real pick runs against a stand-in
 * `atag` (withSwitchStandIn, as t62): one `models start`, after `models use`.
 *
 * ATO-126 — the embedding server never started beside a running local chat
 * model, and hybrid recall stayed off after a cloud trip. Main's real local
 * pick against the stand-in: `models start-embedding` beside a chat server
 * that is up, not after a `models start` that brought it up, nothing when the
 * file does not want it; the flag back on, and the restart that wires it. The
 * bundled agent has the verb.
 *
 * ATO-136 — a local planner after ⇄ is slower, and nothing said so. The ⇄'s
 * tooltip and the swap's toast, on a Fusion config of the check's own, with
 * the swap's IPC stood in.
 *
 * Everything is put back: the window's state, its IPC, the hold's timings.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Handler = (event: unknown, arg: unknown) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = Record<string, any>;

const show = (x: unknown) => JSON.stringify(x);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY = "agent:busyAnywhere";
const OLD = "qwen-3.5-4b";
const NEW = "qwen-3.5-9b";
const EMB = "nomic-embed-text-v1.5";
const CLOUD = "smoke-t112-cloud";

/** The agent's answer to "is anything running?", on the window's own IPC. */
class BusyStandIn {
  answer: unknown = { busy: false, turns: 0, answered: true, state: "connected" };
  asks = 0;
  private readonly handler: Handler = () => { this.asks++; return this.answer; };
  install(wins: BrowserWindow[]): void {
    for (const x of wins) { x.webContents.ipc.removeHandler(BUSY); x.webContents.ipc.handle(BUSY, this.handler); }
  }
  uninstall(wins: BrowserWindow[]): void {
    for (const x of wins) if (!x.isDestroyed()) x.webContents.ipc.removeHandler(BUSY);
  }
}

const KEEP = `(() => {
  if (S.busy || S.pending || RUNNING.size > 0 || SWX.pending || SWX.hold || OPENING) return false;
  window.__t112keep = {err: SWX.err, sendError: SWX.sendError, sendErrors: Object.assign({}, SWX.sendErrors), times: Object.assign({}, SWX.times), lastMs: SWX.lastMs, hold: Object.assign({}, SWX_HOLD),
    toasts: S.toasts.slice(), cfg: LIVE_CONFIG, queued: FZ.swapQueued, swap: SWXBR.swapFusionLegs, owed: DRAIN_OWED, settings: S.settings};
  SWX_HOLD.pollMs = 60; SWX_HOLD.maxMs = 60000; DRAIN_OWED = false;
  return true;
})()`;

const RESTORE = `(async () => {
  const t = window.__t112;
  const k = window.__t112keep; delete window.__t112keep; delete window.__t112;
  if (SWX.hold) SWX.hold.end('cancel');
  if (t && t.p) await t.p.catch(() => {});
  if (k) {
    SWX.err = k.err; SWX.sendError = k.sendError; SWX.sendErrors = k.sendErrors; SWX.times = k.times; SWX.lastMs = k.lastMs; Object.assign(SWX_HOLD, k.hold);
    S.toasts = k.toasts; renderToasts(); LIVE_CONFIG = k.cfg; FZ.swapQueued = k.queued; SWXBR.swapFusionLegs = k.swap;
    DRAIN_OWED = k.owed; S.settings = k.settings;
  }
  render();
  return true;
})()`;

/** Start a switch whose `run` only counts; it runs on in the window while the check looks. */
const START = (want: string) => `(() => {
  const t = window.__t112 = window.__t112 || {runs: 0, results: []};
  t.p = swxRun('switching…', ${want}, () => { t.runs++; return Promise.resolve({ok: true}); })
    .then((r) => { t.results.push(r); return r; });
  return true;
})()`;
const LOOK = `(() => {
  const t = window.__t112 || {runs: 0, results: []};
  const strip = document.querySelector('.statusstrip.swxhold');
  return {runs: t.runs, results: t.results, hold: !!SWX.hold, pending: SWX.pending, timer: !!SWX.timer, err: SWX.err, sendError: SWX.sendError, sendErrors: Object.assign({}, SWX.sendErrors),
    line: swxHoldLine(), strip: strip ? strip.textContent : null,
    acts: strip ? [...strip.querySelectorAll('button[data-act]')].map((b) => b.dataset.act) : [],
    toasts: S.toasts.map((x) => x.t + (x.s ? ' / ' + x.s : ''))};
})()`;
type Look = {
  runs: number; results: Array<{ ok?: boolean; error?: string; cancelled?: boolean }>; hold: boolean; pending: number;
  timer: boolean; err: string | null; line: string; strip: string | null; acts: string[]; toasts: string[];
};
const SETTLE = `(async () => { const t = window.__t112; if (t && t.p) await t.p; return true; })()`;

async function holds(js: Js, check: Check, busy: BusyStandIn): Promise<void> {
  // (a) Busy elsewhere: the switch waits, saying so, then goes on its own once the agent is idle.
  busy.answer = { busy: true, turns: 1, answered: true, state: "connected" };
  await js(START("{backend: 'cloud'}"));
  await wait(250);
  const waiting = await js<Look>(LOOK);
  busy.answer = { busy: false, turns: 0, answered: true, state: "connected" };
  await wait(300);
  await js(SETTLE);
  const went = await js<Look>(LOOK);
  check(
    "T112 (ATO-134): a switch waits for a scheduled task or Telegram reply — lock kept, nothing run, the line and its two ways out; it goes once the agent is idle",
    waiting.hold && waiting.runs === 0 && waiting.pending === 1 && !waiting.timer
      && /Waiting for a scheduled task \/ Telegram reply to finish, then switching/.test(waiting.strip ?? "")
      && show(waiting.acts) === show(["swx:holdnow", "swx:holdcancel"])
      && !went.hold && went.runs === 1 && went.pending === 0 && went.results[0]?.ok === true,
    show({ waiting, went }),
  );

  // (b) Switch now anyway.
  busy.answer = { busy: true, turns: 2, answered: true, state: "connected" };
  await js(START("{backend: 'cloud'}"));
  await wait(200);
  const before = await js<Look>(LOOK);
  await js("act('swx:holdnow'), true");
  await js(SETTLE);
  const now = await js<Look>(LOOK);
  check(
    "T112 (ATO-134): \"Switch now anyway\" runs the held switch at once, the agent still busy",
    before.hold && before.runs === 1 && !now.hold && now.runs === 2 && now.results[1]?.ok === true,
    show({ before, now }),
  );

  // (c) Cancel: nothing runs, the lock goes, said so.
  await js(START("{backend: 'cloud'}"));
  await wait(200);
  await js("act('swx:holdcancel'), true");
  await js(SETTLE);
  const cancelled = await js<Look>(LOOK);
  check(
    "T112 (ATO-134): Cancel switches nothing and lets go of the lock",
    !cancelled.hold && cancelled.runs === 2 && cancelled.pending === 0
      && cancelled.results[2]?.ok === false && cancelled.results[2]?.cancelled === true
      && cancelled.toasts.some((t) => /^Switch cancelled/.test(t)),
    show(cancelled),
  );

  // (d) Past the limit: given up, nothing run, the composer says why.
  await js("SWX_HOLD.maxMs = 250, true");
  await js(START("{backend: 'cloud'}"));
  await wait(700);
  await js(SETTLE);
  const late = await js<Look>(LOOK);
  await js("SWX_HOLD.maxMs = 60000, true");
  check(
    "T112 (ATO-134): a hold past its limit switches nothing, refused as for a running chat, and the composer says so",
    !late.hold && late.runs === 2 && late.pending === 0 && late.results[3]?.error === "a turn is running"
      && /not switched: a scheduled task or Telegram reply was still running/.test(late.err ?? "")
      && late.toasts.some((t) => /^Not while a turn is running \/ A scheduled task or Telegram reply is still running/.test(t)),
    show(late),
  );

  // (e) An agent before 0.6.6 cannot say (no busyTurns): the switch goes as before. The coding mode never asks.
  busy.answer = { busy: true, turns: null, answered: true, state: "connected" };
  await js(START("{backend: 'cloud'}"));
  await js(SETTLE);
  const old = await js<Look>(LOOK);
  const asked = busy.asks;
  await js(START("{route: false}"));
  await js(SETTLE);
  const mode = await js<Look>(LOOK);
  check(
    "T112 (ATO-134): an agent that cannot count its turns does not hold a switch, and the coding mode does not ask",
    old.runs === 3 && !old.hold && busy.asks === asked && mode.runs === 4,
    show({ old: old.runs, mode: mode.runs, asks: busy.asks, asked }),
  );

  // (f) No answer in time (a stuck agent): it waits, says it waits for the agent, and goes after its shorter limit.
  busy.answer = { busy: true, turns: null, answered: false, state: "error" };
  await js("SWX_HOLD.unansweredMs = 300, true");
  await js(START("{backend: 'cloud'}"));
  await wait(120);
  const stuck = await js<Look>(LOOK);
  await wait(600);
  await js(SETTLE);
  const unstuck = await js<Look>(LOOK);
  await js("SWX_HOLD.unansweredMs = 30000, true");
  check(
    "T112 (ATO-134): an agent that never answers holds the switch as waiting for the agent, then the switch goes",
    stuck.hold && /^Waiting for the agent to answer, then switching$/.test(stuck.line) && stuck.runs === 4
      && !unstuck.hold && unstuck.runs === 5,
    show({ stuck, unstuck }),
  );
}

async function planner(js: Js, check: Check): Promise<void> {
  // The composer t11 draws: Fusion · AI/ML API · grok ⇄ the local model.
  const fusion = (orchestrator: string, worker: string) => ({
    llm: {
      activeTextProvider: orchestrator,
      providers: [{ id: "local-llama", kind: "llama-server" }, { id: "aimlapi", kind: "aimlapi", defaultChatModel: "x-ai/grok-4-6" }],
      runMode: { mode: "fusion", fusion: { orchestratorProvider: orchestrator, workerProvider: worker } },
    },
    localModels: { mode: "managed", managed: { modelId: OLD } },
  });
  const r = await js<{ cloudTip: string; localTip: string; hint: string; toasts: string[]; res: unknown }>(`(async () => {
    const tip = () => { const m = /title="([^"]*)"/.exec(fzChipsHtml()); return m ? m[1] : ''; };
    LIVE_CONFIG = ${show(fusion("aimlapi", "local-llama"))}; FZ.swapQueued = false;
    const cloudTip = tip();
    S.toasts = []; renderToasts();   // put back by RESTORE
    SWXBR.swapFusionLegs = () => { SWX.route = 'swapFusionLegs'; LIVE_CONFIG = ${show(fusion("local-llama", "aimlapi"))}; return Promise.resolve({ok: true}); };
    const res = await fzSwapNow();
    const localTip = tip();
    return {cloudTip, localTip, hint: fzLocalPlannerHint(), res: res ? {ok: res.ok} : null,
      toasts: S.toasts.map((x) => x.t + (x.s ? ' / ' + x.s : ''))};
  })()`);
  check(
    "T112 (ATO-136): a ⇄ that leaves a local planner says it is slower, once, and the ⇄'s tooltip keeps saying it; a cloud planner says nothing",
    !/slower/.test(r.cloudTip) && /A local planner is slower — the cloud model is now doing the work/.test(r.localTip)
      && r.toasts.filter((t) => t === "A local planner is slower / The cloud model is now doing the work").length === 1,
    show(r),
  );
}

/** One switch against a stand-in `atag`, as t62: what it answered, the calls it made, the file it left. */
async function standIn(start: Cfg, world: { up: boolean; embFails?: boolean; withEmbedding?: boolean }, act: () => Promise<SwitchResult>) {
  const box = { file: JSON.parse(JSON.stringify(start)) as Cfg };
  let up = world.up;
  const calls: string[] = [];
  const said = (stdout: string): CliResult => ({ ok: true, stdout, stderr: "" });
  const refused = (error: string, stderr = ""): CliResult => ({ ok: false, stdout: "", stderr, error });
  const answer = async (args: string[], input?: string): Promise<CliResult> => {
    const verb = args.slice(0, 2).join(" ");
    calls.push(args[0] === "models" && args[1] === "use" ? `models use ${args[2]}` : verb);
    await wait(5);
    switch (verb) {
      case "config get": return said(JSON.stringify(box.file));
      case "config set":
        if (args[2] !== "-" || input === undefined) return refused("smoke stand-in: only `config set -` is answered");
        box.file = JSON.parse(input);
        return said("");
      case "models status":
        return said(up ? "mode: managed\ndaemon:         running (pid 999999)  http://127.0.0.1:19191\nhealth: ok\n"
          : "mode: managed\ndaemon:         stopped\nhealth: down\n");
      case "models stop": up = false; return said("stopped\n");
      case "models start":
        up = true;
        return said(`chat: started pid 4242, healthy on port 19191\n${world.withEmbedding ? `embedding: started pid 77, healthy on port 19192 (${EMB})\n` : ""}`);
      case "models start-embedding":
        return world.embFails
          ? refused("smoke stand-in: exit 1", "embedding: failed to start (smoke t112: port taken)\n")
          : said(`embedding: started pid 77, healthy on port 19192 (${EMB})\n`);
      case "models use": {
        const lm = (box.file["localModels"] ??= {});
        lm.mode = "managed";
        lm.managed = { ...(lm.managed ?? {}), modelId: args[2] };
        return said(`active model: ${args[2]}\n`);
      }
      case "models list": {
        const active = box.file["localModels"]?.managed?.modelId;
        return said(`ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE\n${[OLD, NEW].map((id) => `${id} | qwen | 4B | 32k | yes | ${id === active ? "*" : ""}`).join("\n")}\n`);
      }
      default: return refused(`smoke stand-in: no answer for \`atag ${verb}\``);
    }
  };
  const res = await withSwitchStandIn(answer, () => act(), { configHint: () => box.file, daemonPidAlive: () => up });
  return { res, calls, file: box.file, count: (v: string) => calls.filter((c) => c === v).length, at: (v: string) => calls.indexOf(v) };
}

const cloudEntry = { id: CLOUD, kind: "openai-compatible", baseUrl: "https://smoke-t112.invalid/v1", apiKey: "smoke-t112-dummy", defaultChatModel: "m" };

async function workerPick(check: Check): Promise<void> {
  const brief = (r: Awaited<ReturnType<typeof standIn>>) => show({ res: { ok: r.res.ok, daemon: r.res.daemon, error: r.res.error }, calls: r.calls });
  // (a) Fusion with local workers on OLD, its server down: picking NEW starts NEW only.
  const inFusion: Cfg = {
    llm: { activeTextProvider: CLOUD, providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" }, cloudEntry],
      runMode: { mode: "fusion", fusion: { orchestratorProvider: CLOUD, workerProvider: "local-llama" } } },
    localModels: { mode: "managed", managed: { modelId: OLD, port: 19191 } },
  };
  const a = await standIn(inFusion, { up: false }, () => selectFusionWorkerModel(NEW));
  check(
    "T112 (ATO-127): a worker model pick with the server down starts only the model picked — one `models start`, after `models use`",
    a.res.ok && a.res.daemon === "started" && a.count("models start") === 1 && a.count("models stop") === 0
      && a.at(`models use ${NEW}`) >= 0 && a.at("models start") > a.at(`models use ${NEW}`)
      && a.file["localModels"]?.managed?.modelId === NEW,
    brief(a),
  );
  // (b) From the cloud route, the pick entering Fusion: still one start, of the model picked.
  const cloud: Cfg = { ...JSON.parse(JSON.stringify(inFusion)), llm: { activeTextProvider: CLOUD, providers: inFusion["llm"].providers } };
  const b = await standIn(cloud, { up: false }, () => selectFusionWorkerModel(NEW));
  check(
    "T112 (ATO-127): the pick that enters Fusion starts no model before the one picked",
    b.res.ok && b.count("models start") === 1 && b.at("models start") > b.at(`models use ${NEW}`)
      && b.file["llm"]?.runMode?.mode === "fusion",
    brief(b),
  );
  // (c) The old model up: stopped once and the new one started once, as before.
  const c = await standIn(inFusion, { up: true }, () => selectFusionWorkerModel(NEW));
  check(
    "T112 (ATO-127): with the old model up, the pick stops it and starts the new one, once each",
    c.res.ok && c.res.daemon === "restarted" && c.count("models stop") === 1 && c.count("models start") === 1
      && c.at("models stop") > c.at(`models use ${NEW}`),
    brief(c),
  );
}

async function embeddings(check: Check): Promise<void> {
  const local = (wanted: boolean): Cfg => ({
    llm: { activeTextProvider: "local-llama", providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191" }, cloudEntry] },
    localModels: { mode: "managed", managed: { modelId: OLD, port: 19191 },
      embeddings: { enabled: wanted, modelId: EMB, port: 19192, url: "http://127.0.0.1:19192" } },
    // After a cloud trip: the Cloud switch turned hybrid recall off.
    memory: { embeddings: { enabled: false } },
  });
  const brief = (r: Awaited<ReturnType<typeof standIn>>) =>
    show({ res: { ok: r.res.ok, daemon: r.res.daemon, restart: r.res.restart, line: r.res.daemonLine }, calls: r.calls, mem: r.file["memory"] });

  // (a) The chat model up, the embedding server not: started alone, hybrid recall back on, and the restart that wires it.
  const a = await standIn(local(true), { up: true }, () => selectLocalModel(OLD));
  check(
    "T112 (ATO-126): beside a chat model already up, the embedding server is started alone, hybrid recall goes back on, and the agent restarts to wire it",
    a.res.ok && a.res.daemon === "untouched" && a.count("models start") === 0 && a.count("models start-embedding") === 1
      && a.file["memory"]?.embeddings?.enabled === true && a.res.restart === true
      && /embedding server up — semantic search on/.test(a.res.daemonLine ?? ""),
    brief(a),
  );
  // (b) The chat model down: `models start` brings both up, and is not followed by a second embedding start.
  const b = await standIn(local(true), { up: false, withEmbedding: true }, () => selectLocalModel(OLD));
  check(
    "T112 (ATO-126): after a `models start` that brought the embedding server up too, no second start; hybrid recall on",
    b.res.ok && b.res.daemon === "started" && b.count("models start") === 1 && b.count("models start-embedding") === 0
      && b.file["memory"]?.embeddings?.enabled === true && b.res.restart === true,
    brief(b),
  );
  // (c) Not wanted: nothing more than before.
  const c = await standIn(local(false), { up: true }, () => selectLocalModel(OLD));
  check(
    "T112 (ATO-126): with embeddings off in the file nothing is started or written, and nothing restarts",
    c.res.ok && c.count("models start-embedding") === 0 && c.count("config set") === 0 && c.res.restart === false,
    brief(c),
  );
  // (d) The start fails: said, nothing written, nothing restarts.
  const d = await standIn(local(true), { up: true, embFails: true }, () => selectLocalModel(OLD));
  check(
    "T112 (ATO-126): an embedding server that does not start is said with its reason, and hybrid recall stays as it was",
    d.res.ok && d.count("models start-embedding") === 1 && d.count("config set") === 0 && d.res.restart === false
      && /the embedding server did not start — smoke t112: port taken/.test(d.res.daemonLine ?? ""),
    brief(d),
  );

  // The bundled agent has the verb (its help, read only).
  const bin = resolveBinary();
  let help = "";
  try {
    if (bin) help = (await promisify(execFile)(bin, ["models", "--help"], { env: agentEnv(), timeout: 30_000, windowsHide: true })).stdout;
  } catch (err) {
    help = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  check(
    "T112 (ATO-126): the agent has `models start-embedding`",
    /start-embedding\s+Start the embedding daemon alone/.test(help),
    bin ? help.split("\n").filter((l) => /embedding/.test(l)).join(" | ") || help.slice(0, 200) : "no atomic-agent binary found",
  );
}

export async function checks112(js: Js, check: Check): Promise<void> {
  await workerPick(check);
  await embeddings(check);

  // ATO-134: main's own answer, before the stand-in takes over.
  const real = await js<{ busy?: unknown; turns?: unknown; answered?: unknown } | null>("BR.agentBusyAnywhere()").catch(() => null);
  check(
    "T112 (ATO-134): main answers agent:busyAnywhere with the agent's own count",
    !!real && typeof real.busy === "boolean" && typeof real.answered === "boolean" && (real.turns === null || typeof real.turns === "number"),
    show(real),
  );

  const wins = BrowserWindow.getAllWindows().filter((x) => !x.isDestroyed());
  const busy = new BusyStandIn();
  let kept = false;
  try {
    busy.install(wins);
    kept = await js<boolean>(KEEP);
    if (!kept) {
      check("T112: the window is idle for the switch checks", false, "a turn, an approval or a switch was in flight; nothing was staged");
      return;
    }
    await holds(js, check, busy);
    busy.answer = { busy: false, turns: 0, answered: true, state: "connected" };
    await planner(js, check);
  } finally {
    if (kept) await js(RESTORE).catch(() => undefined);
    busy.uninstall(wins);
  }
}
