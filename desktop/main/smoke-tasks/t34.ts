import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configGet,
  configSetWhole,
  modelsStart,
  START_REFUSED_MOVED_ON,
  START_REFUSED_QUITTING,
  type UserConfigShape,
} from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import {
  agentStarting,
  bringUpInFlight,
  inDaemonTurn,
  lastTurnEnded,
  restartAfterSwitch,
  restartsAgent,
  selectLocalModel,
  startDaemonNow,
  supersedeBringUp,
  waitForSwitchRestart,
  type SwitchAgent,
} from "../backend-switch.js";
import type { SmokeDownloads } from "../release-fixes-smoke.js";

/**
 * Backlog 18, its second review: a switch's restart of the agent, and a model
 * start's spawn, once the person or the app has moved on. Run with
 * `--smoke --smoke-task=34`.
 *
 *   1 — A model pick waits for the daemon's turn behind the llama.cpp update,
 *       and the window gives up on it at 45 s. A stop or a later switch
 *       meanwhile ended its start (it answered `superseded`), but its answer
 *       still said `restart`, so applySwitch restarted the agent once the
 *       update ended: a second, pointless restart after the cloud pick's own.
 *       A superseded result restarts nothing now.
 *   2 — And by then the person has started a turn: the pick's restart aborted
 *       it, item 28 again from main's side. With a turn in flight applySwitch
 *       holds the restart back and says so (`restartHeld`); it runs once the
 *       last turn ends, or with the next switch, and anything that starts the
 *       agent meanwhile pays it.
 *   3 — Its start's turn checked the quit and the stops only as it began, and
 *       the turn's own `models status` (or `models stop`) takes seconds. A
 *       quit or a stop that came in it was still followed by `models start`,
 *       after the quit had killed every start on its way: a llama-server up
 *       behind the app. `models start` asks again at its spawn now.
 *
 * Nothing restarts the agent, nothing is downloaded, and no model server comes
 * up. Main's own agent hands its restarts to a stand-in for the checks
 * (restartsAgent): it counts them, and says how many turns are in flight — the
 * AgentClient's count, stood in. Its `idle` (the last turn ended) is
 * lastTurnEnded, called here as the client would. As T18's U checks do, every
 * call goes through a guard in front of the agent binary that writes each verb
 * down: `models list` answers a stand-in model on disk, `models use` writes
 * nothing, `models status` reads a flag file (and holds while the check holds
 * it), and `models start`, `models stop` never reach the agent. Everything else
 * reaches the agent, its end written down too. The config is the local route
 * with no model chosen yet, so every pick writes, and is put back after.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Answer = { ok?: boolean; daemon?: string; restart?: boolean; restartHeld?: boolean; error?: string } | null;
/** Main's agent, as a switch sees it, stood in: the turns in flight are set by the check, and the restarts counted. */
type StandIn = SwitchAgent & { turns: number; restarts: number };
type Guard = {
  verbs: () => string[];
  has: (verb: string) => boolean;
  /** A fresh log, the model server down, `models status` answering at once. */
  reset: () => void;
  /** While on, `models status` does not answer (15 s at most). */
  holdStatus: (on: boolean) => void;
  /** A line of the check's own in the log, where the guard writes its verbs. */
  mark: (word: string) => void;
  until: (pred: () => boolean, ms: number) => Promise<boolean>;
  /** A model pick (selectLocalModel) has made its reads and writes and asked for its daemon turn. */
  pickAsked: () => Promise<boolean>;
};

const MODEL = "smoke-t34-model";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const count = (verbs: string[], verb: string) => verbs.filter((v) => v === verb).length;
/** Whether `first` was written down, and before `then`. */
const before = (verbs: string[], first: string, then: string) =>
  verbs.includes(first) && verbs.includes(then) && verbs.indexOf(first) < verbs.indexOf(then);
/** `p`, or a rejection after `ms`: a regression that leaves a call unanswered fails, and the cleanup after it still runs. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}
const brief = (a: Answer) => (a ? { ok: a.ok, daemon: a.daemon, restart: a.restart, restartHeld: a.restartHeld, error: a.error } : null);

function standInAgent(): StandIn {
  const a: StandIn = {
    turns: 0,
    restarts: 0,
    turnsInFlight: () => a.turns,
    restart: async () => { a.restarts += 1; },
  };
  return a;
}

export async function checks34(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const live = (await configGet()).config as UserConfigShape | undefined;
  const bin = resolveBinary();
  if (!live || !bin) {
    check("T34: the checks ran against a guarded agent", false, !live ? "config not read" : "no agent binary");
    return;
  }
  // The local route with no model chosen yet: a pick writes its model, and asks for the agent's restart.
  const route = clone(live);
  route.localModels = {
    ...(route.localModels ?? {}),
    mode: "managed",
    managed: { ...(route.localModels?.managed ?? {}), modelId: null },
  };
  const llm = route.llm ?? {};
  const providers = llm.providers ?? [];
  route.llm = {
    ...llm,
    activeTextProvider: "local-llama",
    providers: providers.some((p) => p.id === "local-llama") ? providers : [...providers, { id: "local-llama", kind: "llama-server" }],
    runMode: { mode: "local" },
  };

  const dir = mkdtempSync(join(tmpdir(), "aa-t34-"));
  const log = join(dir, "verbs.log");
  const up = join(dir, "daemon-up");
  const hold = join(dir, "hold-status");
  const guard = join(dir, "atag-guard.sh");
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models list") echo "models list" >> ${q(log)}`,
    `    printf 'ID | FAMILY | SIZE | CONTEXT | DOWNLOADED | ACTIVE\\n${MODEL} | smoke | 1.0 GB | 4096 | yes | \\n'`,
    `    echo "models list end" >> ${q(log)}; exit 0;;`,
    `  "models use") echo "models use" >> ${q(log)}; echo "models use end" >> ${q(log)}; exit 0;;`,
    `  "models status") echo "models status begin" >> ${q(log)}`,
    `    n=0; while [ -f ${q(hold)} ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done`,
    `    echo "models status end" >> ${q(log)}`,
    `    if [ -f ${q(up)} ]; then printf 'mode:           managed\\ndaemon:         running (pid 1)\\nhealth:         ok\\n'`,
    `    else printf 'mode:           managed\\ndaemon:         stopped\\nhealth:         down\\n'; fi; exit 0;;`,
    `  "models start") echo "models start begin" >> ${q(log)}; : > ${q(up)}`,
    `    echo "models start end" >> ${q(log)}; echo "chat: started pid 1, healthy on port 1"; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; rm -f ${q(up)}; exit 0;;`,
    `  "models pull"|"models pull-embedding"|"models update") echo "refused $1 $2" >> ${q(log)}; exit 1;;`,
    // An agent started through the guard is written down, and then runs as itself (none should be).
    `  serve\\ *) echo "serve" >> ${q(log)};;`,
    // Anything else reaches the agent, its end written down too.
    `  *) printf '%s %s\\n' "$1" "$2" >> ${q(log)}; ${q(bin)} "$@"; c=$?; printf '%s %s end\\n' "$1" "$2" >> ${q(log)}; exit $c;;`,
    "esac",
    `exec ${q(bin)} "$@"`,
    "",
  ].join("\n"));
  chmodSync(guard, 0o755);
  writeFileSync(log, "");
  const verbs = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await wait(50);
    return pred();
  };
  /* As T18's U checks read it: a pick reads the catalogue (`models list`), the
     config, writes its model (`models use`, the url sync) and the route, and
     then asks for its turn. It has asked once every such call since its
     `models list` has ended, two config reads among them, and none began for
     half a second. */
  const PICK_CALLS = ["models list", "config get", "config set", "models use"];
  const pickAsked = async () => {
    let begun = -1;
    let quietSince = Date.now();
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const v = verbs();
      const s = v.includes("models list") ? v.slice(v.indexOf("models list")) : [];
      const b = PICK_CALLS.reduce((n, c) => n + count(s, c), 0);
      const e = PICK_CALLS.reduce((n, c) => n + count(s, `${c} end`), 0);
      if (b !== begun) { begun = b; quietSince = Date.now(); }
      if (count(s, "config get end") >= 2 && e === b && Date.now() - quietSince >= 500) {
        await wait(200);
        return true;
      }
      await wait(50);
    }
    return false;
  };
  const g: Guard = {
    verbs,
    has: (verb) => verbs().includes(verb),
    reset: () => {
      writeFileSync(log, "");
      for (const f of [up, hold]) rmSync(f, { force: true });
    },
    holdStatus: (on) => { if (on) writeFileSync(hold, ""); else rmSync(hold, { force: true }); },
    mark: (word) => appendFileSync(log, `${word}\n`),
    until,
    pickAsked,
  };
  // Nothing the guard answers may still be running, or waiting for its turn, when the real binary is let back in.
  const settle = async () => {
    g.holdStatus(false);
    const bg = bringUpInFlight();
    if (bg) await Promise.race([bg, wait(20_000)]);
    if (bringUpInFlight()) { supersedeBringUp(); await wait(500); }
    const turns = await Promise.race([inDaemonTurn(async () => true, () => true), wait(30_000).then(() => false)]);
    return turns && !bringUpInFlight();
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      check(`T34 ${name}: its checks ran to the end`, false, err instanceof Error ? err.message : String(err));
    }
    if (!(await settle())) throw new Error(`${name} left a start running or waiting for its turn`);
  };

  const keepBin = process.env.ATOMIC_AGENT_BIN;
  // While the checks run, a stand-in takes main's restarts: none reaches `atag serve`.
  const agent = standInAgent();
  const mainAgent = restartsAgent(agent);
  // A restart an earlier check left owed would be paid by the first switch here, and read as this one's.
  agentStarting();
  let guarded = false;
  let settled = false;
  try {
    const busy = main.running();
    if (busy) throw new Error(`a download is already running: ${JSON.stringify(busy)}`);
    const routed = await configSetWhole(route);
    if (!routed.ok) throw new Error(`the local route was not written: ${routed.error ?? "no reason given"}`);
    process.env.ATOMIC_AGENT_BIN = guard;
    guarded = true;
    if (resolveBinary() !== guard) throw new Error(`the guard is not the binary main runs (${resolveBinary()})`);
    await step("1", () => supersededRestartsNothing(js, check, g, agent, main, route));
    await step("2", () => heldWhileTurnsRun(js, check, g, agent));
    await step("3", () => noSpawnOnceMovedOn(js, check, g, main));
    await step("4", () => stopLeavesNoAgentBehindTheFile(js, check, g, agent, main, route));
    settled = await settle();
  } catch (err) {
    check("T34: the checks ran against a guarded agent", false, err instanceof Error ? err.message : String(err));
    // Before the guard went in nothing here asked main for anything.
    settled = guarded ? await settle() : true;
  } finally {
    // Nothing is owed to the stand-in when main's own agent goes back.
    agent.turns = 0;
    lastTurnEnded();
    await waitForSwitchRestart();
    restartsAgent(mainAgent);
    if (settled) {
      if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
      rmSync(dir, { recursive: true, force: true });
    } else {
      check("T34: nothing the guard answered was left running before the guard was taken away", false, "still running — the guard stays in place");
    }
    const back = await configSetWhole(live);
    if (!back.ok) check("T34: the config the checks found was put back", false, back.error ?? "no reason given");
  }
}

/* 1: a model pick through the real IPC (so its answer passes applySwitch)
   waits for the daemon's turn, which the check holds as the llama.cpp update
   does. Settings' Stop meanwhile stands for every stop and route change
   (supersedeBringUp): a cloud pick, another model, the seats moving to the
   cloud. The pick writes its model, so its answer asked for a restart. */
async function supersededRestartsNothing(js: Js, check: Check, g: Guard, agent: StandIn, main: SmokeDownloads, route: UserConfigShape): Promise<void> {
  // serve booted on the route the file names: a stop that supersedes the pick leaves nothing behind (backlog 35 is check 4).
  const undoBoot = main.bootedOn(route);
  try {
    await supersededOnItsRoute(js, check, g, agent);
  } finally {
    undoBoot();
  }
}
async function supersededOnItsRoute(js: Js, check: Check, g: Guard, agent: StandIn): Promise<void> {
  g.reset();
  agent.turns = 0;
  agent.restarts = 0;
  let release = () => {};
  let began = () => {};
  const begun = new Promise<void>((r) => { began = () => r(); });
  // Held until released, and a minute at most: a check that fails before its release never blocks the daemon's turns for good.
  const held = inDaemonTurn(
    () => new Promise<void>((r) => { release = () => r(); began(); setTimeout(() => r(), 60_000); }),
    () => { began(); return undefined; },
  );
  let stop: Answer = null;
  let p: Answer = null;
  try {
    await within(30_000, "the check's daemon turn", begun);
    const pick = js<Answer>(`window.atomic.selectLocalModel(${JSON.stringify(MODEL)})`);
    if (!(await g.pickAsked())) throw new Error(`the pick never asked for its turn: ${JSON.stringify(g.verbs())}`);
    stop = await within(10_000, "Settings' Stop", js<Answer>("window.atomic.modelsStop()"));
    release();
    await held;
    p = await within(30_000, "the superseded pick", pick);
    await wait(300);
  } finally {
    release();
  }
  const after = g.verbs();
  check(
    "T34 1: a model pick that a stop or a switch superseded while it waited for the daemon's turn restarts nothing once its turn comes — not the agent (already on the file's route), not the model server",
    stop?.ok === true && p?.ok === true && p.daemon === "superseded" && p.restart === false && agent.restarts === 0
      && !after.includes("models start begin"),
    JSON.stringify({ stop: brief(stop), pick: brief(p), restarts: agent.restarts, verbs: after }),
  );
  // Where applySwitch asks: any superseded result, though it moved the file or serve is behind it.
  const direct = await restartAfterSwitch({ ok: true, providerId: "local-llama", daemon: "superseded", restart: true }, true);
  check(
    "T34 1: applySwitch restarts nothing for a superseded result, though it says the file moved",
    direct.restart === false && !direct.restartHeld && agent.restarts === 0,
    JSON.stringify({ direct, restarts: agent.restarts }),
  );
}

/* 2: a model pick through the real IPC that lands while a turn is in flight
   (the client's count, stood in), then the turns ending. */
async function heldWhileTurnsRun(js: Js, check: Check, g: Guard, agent: StandIn): Promise<void> {
  g.reset();
  agent.turns = 1;
  agent.restarts = 0;
  const p = await within(30_000, "the pick", js<Answer>(`window.atomic.selectLocalModel(${JSON.stringify(MODEL)})`));
  await wait(300);
  const whileRunning = agent.restarts;
  check(
    "T34 2: a model pick that lands while a turn is in flight does not restart the agent under it, and says the restart is held",
    p?.ok === true && (p.daemon === "started" || p.daemon === "restarted") && p.restart === false && p.restartHeld === true
      && whileRunning === 0,
    JSON.stringify({ pick: brief(p), restarts: whileRunning, verbs: g.verbs() }),
  );

  // Another chat still answering: the restart waits for it too.
  lastTurnEnded();
  await wait(300);
  const oneLeft = agent.restarts;
  // The last turn ends (the client's `idle`): the restart runs, once.
  agent.turns = 0;
  lastTurnEnded();
  await within(10_000, "the held restart", waitForSwitchRestart());
  lastTurnEnded();
  await waitForSwitchRestart();
  check(
    "T34 2: the held restart runs once the last turn ends — not while another chat still has one running, and only once",
    oneLeft === 0 && agent.restarts === 1,
    JSON.stringify({ whileOneLeft: oneLeft, restarts: agent.restarts }),
  );

  // Anything that starts the agent meanwhile (a restart from Settings, a new workspace) pays it.
  agent.turns = 1;
  const held = await restartAfterSwitch({ ok: true, providerId: "local-llama", restart: true }, true);
  agentStarting();
  agent.turns = 0;
  lastTurnEnded();
  await waitForSwitchRestart();
  const afterStart = agent.restarts;
  // A switch that lands after the turns, before their end was seen, pays it too, though it moved nothing.
  agent.turns = 1;
  const held2 = await restartAfterSwitch({ ok: true, providerId: "local-llama", restart: true }, true);
  agent.turns = 0;
  const next = await restartAfterSwitch({ ok: true, providerId: "local-llama", restart: false }, false);
  lastTurnEnded();
  await waitForSwitchRestart();
  check(
    "T34 2: a held restart is paid by anything that starts the agent meanwhile, or by the next switch — never twice",
    held.restartHeld === true && afterStart === 1 && held2.restartHeld === true && next.restart === true && agent.restarts === 2,
    JSON.stringify({ held, afterStart, held2, next, restarts: agent.restarts }),
  );
}

/* 3: `models start` at its spawn, once the quit has begun (main.quit(), what
   before-quit does first; its undo after) or a stop has come. */
async function noSpawnOnceMovedOn(js: Js, check: Check, g: Guard, main: SmokeDownloads): Promise<void> {
  // (a) Reached once the quit has begun, it spawns nothing; the quit undone, it spawns as before.
  g.reset();
  const reopen = main.quit();
  let closed: Awaited<ReturnType<typeof modelsStart>> | null = null;
  try {
    closed = await within(10_000, "a start once the app quits", modelsStart());
  } finally {
    reopen();
  }
  const whileClosed = g.verbs();
  const open = await within(10_000, "a start", modelsStart());
  const reopened = g.verbs();
  check(
    "T34 3: once the quit has begun `models start` spawns nothing, and says so — the quit undone, it spawns as before",
    closed?.ok === false && closed.notStarted === true && closed.error === START_REFUSED_QUITTING && !whileClosed.includes("models start begin")
      && open.ok === true && reopened.includes("models start begin"),
    JSON.stringify({ closed: closed && { ok: closed.ok, notStarted: closed.notStarted, error: closed.error }, open: { ok: open.ok, error: open.error }, whileClosed, reopened }),
  );

  // (b) A model pick whose turn began before the quit, still in that turn's `models status` as it comes.
  g.reset();
  g.holdStatus(true);
  const pick = selectLocalModel(MODEL);
  if (!(await g.until(() => g.has("models status begin"), 20_000))) {
    g.holdStatus(false);
    throw new Error(`the pick never reached its daemon turn's models status: ${JSON.stringify(g.verbs())}`);
  }
  const reopen2 = main.quit();
  let p: Awaited<ReturnType<typeof selectLocalModel>> | null = null;
  try {
    g.mark("quit");
    g.holdStatus(false);
    p = await within(20_000, "the pick once the app quits", pick);
    await wait(300);
  } finally {
    reopen2();
  }
  const quitVerbs = g.verbs();
  check(
    "T34 3: a model pick still in its daemon turn's `models status` as the app quits spawns no `models start` after it — no model server comes up behind the app",
    !!p && p.ok === true && p.daemon === "superseded" && before(quitVerbs, "models status begin", "quit")
      && before(quitVerbs, "quit", "models status end") && !quitVerbs.includes("models start begin"),
    JSON.stringify({ pick: p && { ok: p.ok, daemon: p.daemon, restart: p.restart, error: p.error }, verbs: quitVerbs }),
  );

  // (c) Settings' Start in its turn's `models status` when Settings' Stop comes.
  g.reset();
  g.holdStatus(true);
  const settings = startDaemonNow();
  if (!(await g.until(() => g.has("models status begin"), 10_000))) {
    g.holdStatus(false);
    throw new Error(`Settings' Start never reached its models status: ${JSON.stringify(g.verbs())}`);
  }
  const stop = await within(10_000, "Settings' Stop", js<Answer>("window.atomic.modelsStop()"));
  g.mark("stop");
  g.holdStatus(false);
  const s = await within(20_000, "Settings' Start", settings);
  await wait(300);
  const stopVerbs = g.verbs();
  check(
    "T34 3: a start in its turn's `models status` when a stop comes spawns nothing — asked again at the spawn, not only as its turn began",
    stop?.ok === true && s.ok === false && s.error === START_REFUSED_MOVED_ON && before(stopVerbs, "models status begin", "stop")
      && before(stopVerbs, "stop", "models status end") && !stopVerbs.includes("models start begin"),
    JSON.stringify({ stop: brief(stop), start: { ok: s.ok, error: s.error }, verbs: stopVerbs }),
  );
}

/* 4 (backlog 35): the pick of check 1, but serve booted on a cloud route. A
   stop that supersedes the pick moves no route, so the agent would stay on
   the cloud while the file — and every chip the window reads — names the
   local model. applySwitch restarts it onto the file's route, once, and still
   starts no model server. With a second pick on its way as well, only the
   last answer restarts it: one restart, never two. */
async function stopLeavesNoAgentBehindTheFile(js: Js, check: Check, g: Guard, agent: StandIn, main: SmokeDownloads, route: UserConfigShape): Promise<void> {
  const cloud = clone(route);
  cloud.llm = {
    ...(cloud.llm ?? {}),
    activeTextProvider: "smoke-t35-cloud",
    providers: [...(cloud.llm?.providers ?? []), { id: "smoke-t35-cloud", kind: "openai-compatible", defaultChatModel: "smoke-t35-chat" }],
    runMode: { mode: "cloud" },
  };
  const undoBoot = main.bootedOn(cloud);
  try {
    // (a) One pick, superseded by Settings' Stop.
    const one = await pickThenStop(js, g, agent, 1);
    check(
      "T34 4 (backlog 35): a model pick that Settings' Stop superseded restarts an agent that booted on the cloud onto the local route the file names — once — and starts no model server",
      one.stop?.ok === true && one.picks.length === 1 && one.picks[0]?.ok === true && one.picks[0]?.daemon === "superseded"
        && one.picks[0]?.restart === true && agent.restarts === 1 && !one.verbs.includes("models start begin"),
      JSON.stringify({ stop: brief(one.stop), picks: one.picks.map(brief), restarts: agent.restarts, verbs: one.verbs }),
    );
    // (b) Two picks waiting, both superseded: the first to answer sees the other on its way and leaves the restart to it.
    const two = await pickThenStop(js, g, agent, 2);
    const restarted = two.picks.filter((p) => p?.restart === true).length;
    check(
      "T34 4 (backlog 35): with a second switch on its way the restart is left to the last one — one restart, not two",
      two.stop?.ok === true && two.picks.length === 2 && two.picks.every((p) => p?.ok === true && p.daemon === "superseded")
        && restarted === 1 && agent.restarts === 1 && !two.verbs.includes("models start begin"),
      JSON.stringify({ stop: brief(two.stop), picks: two.picks.map(brief), restarts: agent.restarts, verbs: two.verbs }),
    );
  } finally {
    undoBoot();
  }
  // (c) Where applySwitch asks: a drifted superseded result restarts; a plain superseded one still does not.
  agent.restarts = 0;
  const plain = await restartAfterSwitch({ ok: true, providerId: "local-llama", daemon: "superseded", restart: false }, true);
  const drifted = await restartAfterSwitch({ ok: true, providerId: "local-llama", daemon: "superseded", restart: false }, true, true);
  check(
    "T34 4 (backlog 35): restartAfterSwitch restarts a superseded result only when main says the file left serve's route",
    plain.restart === false && drifted.restart === true && agent.restarts === 1,
    JSON.stringify({ plain, drifted, restarts: agent.restarts }),
  );
}

/** `n` model picks through the real IPC wait behind a held daemon turn; Settings' Stop; the turn let go. */
async function pickThenStop(js: Js, g: Guard, agent: StandIn, n: number): Promise<{ stop: Answer; picks: Answer[]; verbs: string[] }> {
  g.reset();
  agent.turns = 0;
  agent.restarts = 0;
  let release = () => {};
  let began = () => {};
  const begun = new Promise<void>((r) => { began = () => r(); });
  const held = inDaemonTurn(
    () => new Promise<void>((r) => { release = () => r(); began(); setTimeout(() => r(), 60_000); }),
    () => { began(); return undefined; },
  );
  let stop: Answer = null;
  let picks: Answer[] = [];
  try {
    await within(30_000, "the check's daemon turn", begun);
    const pending: Promise<Answer>[] = [];
    for (let i = 0; i < n; i++) {
      pending.push(js<Answer>(`window.atomic.selectLocalModel(${JSON.stringify(MODEL)})`));
      // Each pick has made its reads and writes and asked for its turn before the next one comes.
      if (!(await g.until(() => count(g.verbs(), "models list end") >= i + 1, 20_000))) throw new Error(`pick ${i + 1} never read the catalogue: ${JSON.stringify(g.verbs())}`);
      if (i === 0 && !(await g.pickAsked())) throw new Error(`the pick never asked for its turn: ${JSON.stringify(g.verbs())}`);
      if (i > 0) await wait(1_500);
    }
    stop = await within(10_000, "Settings' Stop", js<Answer>("window.atomic.modelsStop()"));
    release();
    await held;
    picks = await within(30_000, "the superseded picks", Promise.all(pending));
    await waitForSwitchRestart();
    await wait(300);
  } finally {
    release();
  }
  return { stop, picks, verbs: g.verbs() };
}
