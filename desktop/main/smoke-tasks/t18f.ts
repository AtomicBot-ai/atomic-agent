import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chatModelsList, configGet, configSetWhole, type UserConfigShape } from "../agent-cli.js";
import { resolveBinary } from "../agent-client.js";
import {
  bringUpAtLaunch,
  bringUpInFlight,
  onBackgroundBringUp,
  selectLocalModel,
  supersedeBringUp,
  type BringUp,
} from "../backend-switch.js";
import type { SmokeDownloads } from "../release-fixes-smoke.js";

/**
 * Backlog 18, found by the review of its deferred fixes (older than them):
 * the llama.cpp update against the model starts, and at quit. Run with
 * `--smoke --smoke-task=18`.
 *
 *   U1 — Settings › Models' update (`B`, `atag models update`) stops the model
 *        server and replaces its binary. Every other download refused while it
 *        ran, but a model start did not: it brought the server up on a binary
 *        being replaced, and `models start` fetches a newer binary itself
 *        (localModels.managed.autoUpdate), a second download into the same data
 *        dir. Settings' Start, the launch start and a model pick (where the
 *        composer's switch and a setup download's deferred start both end,
 *        cli:selectLocalModel) wait for the update now, and go once it has
 *        finished: one start, the others finding the server up.
 *   U2 — The other way round: asked for while a start is on its way, the
 *        update waits for it instead of stopping a server that is loading.
 *   U3 — The setup's own llama.cpp download (cli:modelsUpdateStream, the same
 *        `models update`, the runtime row on the card) takes the same turn, and
 *        its × while it waits ends it at once: it never begins.
 *   U4 — The update could not be stopped: quitting stopped the downloads on the
 *        card only, and it wrote on after the app was gone. Quitting stops it
 *        now, and a start that waited behind it does not begin as the app goes.
 *
 * Nothing is downloaded and no model server comes up. As T11 does, every call
 * goes through a guard in front of the agent binary that writes each verb down
 * and never lets `models update`, `models start`, `models stop` or `models
 * status` reach the agent, and refuses a pull. Its update stops the server and
 * then holds until the check lets it end (a minute at most); a killed one never
 * writes its end. Its start marks the server up as it begins and ends after
 * `slow` seconds. The config is the local route on a model on disk, so a pick
 * writes nothing and nothing restarts; the config is put back after, and the
 * real binary only once nothing the guard answered is still running.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Answer = { ok?: boolean; started?: boolean; alreadyRunning?: boolean; error?: string; stdout?: string } | null;
type Frame = { id?: string; done?: boolean; ok?: boolean; error?: string | null; kind?: string };
type Guard = {
  model: string;
  pidFile: string;
  verbs: () => string[];
  has: (verb: string) => boolean;
  /** A fresh log, the server down, the update held; a start takes `startSeconds`. */
  reset: (startSeconds: number) => void;
  letUpdateEnd: () => void;
  until: (pred: () => boolean, ms: number) => Promise<boolean>;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const count = (verbs: string[], verb: string) => verbs.filter((v) => v === verb).length;
/** Whether `first` was written down, and before `then`. */
const before = (verbs: string[], first: string, then: string) =>
  verbs.includes(first) && verbs.includes(then) && verbs.indexOf(first) < verbs.indexOf(then);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** `p`, or a rejection after `ms`: a regression that leaves a call unanswered fails, and the cleanup after it still runs. */
function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms / 1000} s`)), ms);
  });
  return Promise.race([p, late]).finally(() => { if (timer) clearTimeout(timer); });
}
/** `p`'s answer, or null when it is not in within `ms` — for a check that fails on the wait itself. */
async function inTime<T>(ms: number, p: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => { timer = setTimeout(() => r(null), ms); });
  try {
    return await Promise.race([p, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checks18f(js: Js, check: Check, main: SmokeDownloads): Promise<void> {
  const live = (await configGet()).config as UserConfigShape | undefined;
  const bin = resolveBinary();
  const list = await chatModelsList();
  const onDisk = (list.models ?? []).filter((m) => m.downloaded);
  const model = onDisk.find((m) => m.id === live?.localModels?.managed?.modelId) ?? onDisk[0];
  if (!live || !bin || !model) {
    check("T18 U: the update and the starts ran against a guarded agent", false,
      !live ? "config not read" : !bin ? "no agent binary" : "no local model on disk to start");
    return;
  }
  // The local route on that model: a pick finds nothing to write, and nothing restarts.
  const localCfg = clone(live);
  localCfg.localModels = {
    ...(localCfg.localModels ?? {}),
    mode: "managed",
    managed: { ...(localCfg.localModels?.managed ?? {}), modelId: model.id },
  };
  const llm = localCfg.llm ?? {};
  const providers = llm.providers ?? [];
  localCfg.llm = {
    ...llm,
    activeTextProvider: "local-llama",
    providers: providers.some((p) => p.id === "local-llama") ? providers : [...providers, { id: "local-llama", kind: "llama-server" }],
    runMode: { mode: "local" },
  };

  const dir = mkdtempSync(join(tmpdir(), "aa-t18f-"));
  const log = join(dir, "verbs.log");
  const up = join(dir, "daemon-up");
  const slow = join(dir, "slow");
  const ends = join(dir, "update-ends");
  const pidFile = join(dir, "update.pid");
  const guard = join(dir, "atag-guard.sh");
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  writeFileSync(guard, [
    "#!/bin/sh",
    `case "$1 $2" in`,
    `  "models update") echo "models update begin" >> ${q(log)}; echo $$ > ${q(pidFile)}; rm -f ${q(up)}`,
    `    n=0; while [ ! -f ${q(ends)} ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n+1)); done`,
    `    echo "models update end" >> ${q(log)}; echo "done. run 'atomic-agent models start' to use the new backend."; exit 0;;`,
    `  "models start") echo "models start begin" >> ${q(log)}; : > ${q(up)}`,
    `    sleep "$(cat ${q(slow)} 2>/dev/null || echo 1)"`,
    `    echo "models start end" >> ${q(log)}; : > ${q(up)}; echo "chat: started pid 1, healthy on port 1"; exit 0;;`,
    `  "models stop") echo "models stop" >> ${q(log)}; rm -f ${q(up)}; exit 0;;`,
    `  "models status") echo "models status" >> ${q(log)}`,
    `    if [ -f ${q(up)} ]; then printf 'mode:           managed\\ndaemon:         running (pid 1)\\nhealth:         ok\\n'`,
    `    else printf 'mode:           managed\\ndaemon:         stopped\\nhealth:         down\\n'; fi; exit 0;;`,
    `  "models pull"|"models pull-embedding") echo "refused $1 $2" >> ${q(log)}; exit 1;;`,
    `  *) printf '%s %s\\n' "$1" "$2" >> ${q(log)};;`,
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
  const g: Guard = {
    model: model.id,
    pidFile,
    verbs,
    has: (verb) => verbs().includes(verb),
    reset: (startSeconds) => {
      writeFileSync(log, "");
      writeFileSync(slow, String(startSeconds));
      for (const f of [up, ends, pidFile]) rmSync(f, { force: true });
    },
    letUpdateEnd: () => writeFileSync(ends, ""),
    until,
  };
  // Nothing the guard answers may still be running when the real binary is let back in.
  const settle = async () => {
    g.letUpdateEnd();
    await until(() => main.running() === null, 15_000);
    const bg = bringUpInFlight();
    if (bg) await Promise.race([bg, wait(20_000)]);
    if (bringUpInFlight()) { supersedeBringUp(); await wait(500); }
    return main.running() === null && !bringUpInFlight();
  };
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      check(`T18 ${name}: its checks ran to the end`, false, err instanceof Error ? err.message : String(err));
    }
    if (!(await settle())) throw new Error(`${name} left a download or a start running`);
  };

  const keepBin = process.env.ATOMIC_AGENT_BIN;
  // A launch start asked for here is the check's: the window is not told of it.
  const mainReport = onBackgroundBringUp(() => {});
  let settled = false;
  try {
    const busy = main.running();
    if (busy) throw new Error(`a download is already running: ${JSON.stringify(busy)}`);
    await configSetWhole(localCfg);
    process.env.ATOMIC_AGENT_BIN = guard;
    // The update is only ever asked for with the guard in front of the agent.
    if (resolveBinary() !== guard) throw new Error(`the guard is not the binary main runs (${resolveBinary()})`);
    // The setup's runtime download tells the window how it ended: those frames, collected.
    await js<unknown>(`(() => {
      window.__t18f = [];
      window.__t18fOff = window.atomic.onPull((ev) => { if (ev && ev.id === 'llama.cpp') window.__t18f.push(ev); });
    })()`);
    await step("U1", () => startsWaitForUpdate(js, check, g));
    await step("U2", () => updateWaitsForStart(js, check, g));
    await step("U3", () => runtimeDownloadTakesTurn(js, check, g, main));
    await step("U4", () => quitStopsUpdate(js, check, g, main));
    settled = await settle();
  } catch (err) {
    check("T18 U: the update and the starts ran against a guarded agent", false, err instanceof Error ? err.message : String(err));
    settled = await settle();
  } finally {
    onBackgroundBringUp(mainReport);
    await js<unknown>("(() => { if (window.__t18fOff) window.__t18fOff(); delete window.__t18fOff; delete window.__t18f; })()")
      .catch(() => undefined);
    if (settled) {
      if (keepBin === undefined) delete process.env.ATOMIC_AGENT_BIN; else process.env.ATOMIC_AGENT_BIN = keepBin;
      rmSync(dir, { recursive: true, force: true });
    } else {
      check("T18 U: nothing the guard answered was left running before the guard was taken away", false, "still running — the guard stays in place");
    }
    await configSetWhole(live);
  }
}

/* U1: three starts asked for while Settings' update runs. The pick reads the
   catalogue and the config before it asks for its turn, a few CLI reads: the
   window to watch opens once its `models list` is in, and stays open 5 s. */
async function startsWaitForUpdate(js: Js, check: Check, g: Guard): Promise<void> {
  g.reset(1);
  const update = js<Answer>("window.atomic.modelsUpdate()");
  if (!(await g.until(() => g.has("models update begin"), 10_000))) throw new Error("Settings' update never began");
  const pick = selectLocalModel(g.model);
  const settings = js<Answer>("window.atomic.modelsStart()");
  const launch = bringUpAtLaunch(g.model);
  await g.until(() => g.has("models list"), 10_000);
  await wait(5_000);
  const during = g.verbs();
  g.letUpdateEnd();
  const u = await within(15_000, "Settings' update", update);
  const [p, s, l] = await within(30_000, "the starts asked for during it", Promise.all([pick, settings, launch]));
  await wait(300);
  const after = g.verbs();
  check(
    "T18 U1: while Settings' llama.cpp update runs no model start reaches the agent — Settings' Start, the launch start and a model pick (the composer's switch, a setup download's deferred start) all wait",
    during.includes("models update begin") && !during.includes("models update end") && !during.includes("models start begin"),
    JSON.stringify(during),
  );
  check(
    "T18 U1: once it has finished they go in turn — one start, after it, and the others find the server up",
    u?.ok === true && count(after, "models start begin") === 1 && before(after, "models update end", "models start begin")
      && p.ok === true && s?.ok === true && (l.daemon === "started" || l.daemon === "untouched"),
    JSON.stringify({ update: u, pick: { ok: p.ok, daemon: p.daemon, error: p.error }, settings: s, launch: l, verbs: after }),
  );
}

/* U2: a start on its way (3 s), then Settings' update. Once it begins, the
   update ends at once. */
async function updateWaitsForStart(js: Js, check: Check, g: Guard): Promise<void> {
  g.reset(3);
  const settings = js<Answer>("window.atomic.modelsStart()");
  if (!(await g.until(() => g.has("models start begin"), 10_000))) throw new Error("Settings' Start never began");
  g.letUpdateEnd();
  const update = js<Answer>("window.atomic.modelsUpdate()");
  await wait(1_000);
  const mid = g.verbs();
  const [s, u] = await within(20_000, "the start and the update", Promise.all([settings, update]));
  const after = g.verbs();
  check(
    "T18 U2: Settings' llama.cpp update asked for while a model start is on its way waits for it, rather than stopping a server that is loading and replacing its binary",
    !mid.includes("models update begin") && s?.ok === true && u?.ok === true && before(after, "models start end", "models update begin"),
    JSON.stringify({ mid, after, start: s, update: u }),
  );
}

/* U3: the setup's runtime download, asked for as the card's queue asks for it.
   The window holds no job for it, so none of its own subscribers acts on the
   frames; the check's collector reads them. */
async function runtimeDownloadTakesTurn(js: Js, check: Check, g: Guard, main: SmokeDownloads): Promise<void> {
  // (a) A start asked for while it downloads.
  g.reset(1);
  await js<unknown>("window.__t18f.length = 0");
  const asked = await within(10_000, "the runtime download", js<Answer>("window.atomic.modelsUpdateStream()"));
  if (!(await g.until(() => g.has("models update begin"), 10_000))) throw new Error(`the runtime download never began: ${JSON.stringify(asked)}`);
  const settings = js<Answer>("window.atomic.modelsStart()");
  await wait(2_500);
  const mid = g.verbs();
  g.letUpdateEnd();
  await g.until(() => main.running() === null, 15_000);
  const s = await within(20_000, "Settings' Start", settings);
  await wait(300);
  const after = g.verbs();
  const frames = await js<Frame[]>("window.__t18f.splice(0)");
  check(
    "T18 U3: the setup's llama.cpp download takes the same turn — a model start asked for during it waits, and goes once it has landed",
    asked?.ok === true && mid.includes("models update begin") && !mid.includes("models start begin")
      && s?.ok === true && before(after, "models update end", "models start begin")
      && frames.some((f) => f.done === true && f.ok === true),
    JSON.stringify({ asked, mid, after, start: s, frames }),
  );

  // (b) Asked for while a start is on its way (3 s), then its ×.
  g.reset(3);
  const settings2 = js<Answer>("window.atomic.modelsStart()");
  if (!(await g.until(() => g.has("models start begin"), 10_000))) throw new Error("Settings' Start never began");
  const asked2 = await within(10_000, "the runtime download", js<Answer>("window.atomic.modelsUpdateStream()"));
  await wait(800);
  const mid2 = g.verbs();
  const cancelled = await within(10_000, "its ×", js<boolean>("window.atomic.cancelPull()"));
  await wait(400);
  const free = main.running();
  const told = await js<Frame[]>("window.__t18f.slice()");
  const s2 = await within(20_000, "Settings' Start", settings2);
  await wait(1_500);
  const after2 = g.verbs();
  await js<unknown>("window.__t18f.length = 0");
  check(
    "T18 U3: asked for while a model start is on its way, the setup's llama.cpp download waits for it rather than stopping a server that is loading",
    asked2?.ok === true && !mid2.includes("models update begin"),
    JSON.stringify({ asked: asked2, mid: mid2 }),
  );
  check(
    "T18 U3: its × while it waits ends it at once — main is free, the window is told, and it never begins",
    cancelled === true && free === null && told.some((f) => f.done === true && f.ok === false)
      && s2?.ok === true && !after2.includes("models update begin"),
    JSON.stringify({ cancelled, free, told, start: s2, after: after2 }),
  );
}

/* U4: Settings' update running, with Settings' Start and the launch start
   asked for behind it, and then what main's before-quit does before it stops
   the agent (main.quit()). What the quit leaves closed is opened again after. */
async function quitStopsUpdate(js: Js, check: Check, g: Guard, main: SmokeDownloads): Promise<void> {
  g.reset(1);
  const update = js<Answer>("window.atomic.modelsUpdate()");
  if (!(await g.until(() => g.has("models update begin") && existsSync(g.pidFile), 10_000))) throw new Error("Settings' update never began");
  const pid = Number(readFileSync(g.pidFile, "utf8").trim());
  const settings = js<Answer>("window.atomic.modelsStart()");
  const launch = bringUpAtLaunch(g.model);
  await wait(1_000);
  const t0 = Date.now();
  const reopen = main.quit();
  let u: Answer = null;
  let ms = 0;
  let after: string[] = [];
  let running = true;
  let s: Answer = null;
  let l: BringUp | null = null;
  try {
    u = await inTime(5_000, update);
    ms = Date.now() - t0;
    await wait(2_000);
    after = g.verbs();
    running = alive(pid);
    // An update the quit missed ends now, so nothing below waits on it.
    g.letUpdateEnd();
    s = await within(20_000, "Settings' Start", settings);
    l = await within(20_000, "the launch start", launch);
    await wait(300);
  } finally {
    reopen();
  }
  const late = g.verbs();
  check(
    "T18 U4: quitting stops Settings' llama.cpp update at once — it answers, its process is gone, and it writes nothing more",
    !!u && u.ok === false && ms < 5_000 && !running && !after.includes("models update end"),
    JSON.stringify({ update: u, ms, alive: running, verbs: after }),
  );
  check(
    "T18 U4: a model start waiting behind that update does not begin as the app quits — Settings' Start and the launch start",
    !after.includes("models start begin") && !late.includes("models start begin") && s?.ok === false && l?.daemon === "superseded",
    JSON.stringify({ start: s, launch: l, verbs: late }),
  );
}
