import { withConfigLock, type CliResult, type DaemonLifecycle } from "../agent-cli.js";
import {
  activateProvider,
  inDaemonTurn,
  selectCloudModel,
  stopDaemonNow,
  switchBackend,
  withSwitchStandIn,
  type StandInBook,
  type SwitchResult,
} from "../backend-switch.js";

/**
 * Release-fix checks for backlog item 62 (ATO-157, see main/release-fixes-smoke.ts).
 * Run alone with `--smoke --smoke-task=62`.
 *
 * 62 — "Switching between Local models and Cloud is very slow." Besides the
 * model's own start (item 39), every switch ran its `atag` processes one
 * after another, ~0.6 s each: the cloud switch read the whole config four
 * times around its two writes, a `models status` and a `models stop`; the
 * local one read it twice around its write, after `models list`. A switch
 * now reads the config once and writes it once (the embeddings flag only
 * when it is still on), and the Cloud switch asks the model server's status
 * beside that read when a stop looks needed and nothing can be starting.
 *
 * Checked here by counting: main's real switch code runs inside
 * withSwitchStandIn, where every `atag` call it makes is answered by a
 * stand-in that keeps a config in memory, and the daemon's bookkeeping (its
 * turns, marks and background bring-up), the config lock, the count of stops,
 * the lifecycle events and the hints read from disk are the check's own. So
 * the real config is never read or written, no model server is stopped or
 * started, the app's own starts and stops are neither ended nor waited for
 * nor counted, the supervisor hears nothing, and no agent is restarted (that
 * is main.ts's applySwitch, not called here). Nothing the app does meanwhile
 * reaches the checks either, so they need no quiet moment to run in.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = Record<string, any>;

const q = (v: unknown) => JSON.stringify(v);
const MODEL = "qwen-3.5-4b";
const CLOUD = "smoke-t62-cloud";
const NO_KEY = "smoke-t62-nokey";
const NO_MODEL = "smoke-t62-nomodel";
const BASE = "https://smoke-t62.invalid/v1";

/** A file on the local route, with a cloud provider configured and a dummy key saved for it (nothing is sent anywhere). */
function file(opts: { embeddings?: boolean; withKey?: boolean; fusion?: boolean; active?: string; modelId?: string; noModelEntry?: boolean } = {}): Cfg {
  const cloud = opts.withKey === false
    ? { id: NO_KEY, kind: "openai-compatible", baseUrl: BASE, apiKeyEnvVar: "SMOKE_T62_NO_SUCH_KEY", defaultChatModel: "m" }
    : { id: CLOUD, kind: "openai-compatible", baseUrl: BASE, apiKey: "smoke-t62-dummy", defaultChatModel: "m" };
  return {
    llm: {
      activeTextProvider: opts.active ?? (opts.fusion ? cloud.id : "local-llama"),
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        cloud,
        // A provider set up with no chat model yet (j). Only there: Cloud would pick it, as the first one with a key, over NO_KEY.
        ...(opts.noModelEntry ? [{ id: NO_MODEL, kind: "openai-compatible", baseUrl: BASE, apiKey: "smoke-t62-dummy" }] : []),
      ],
      ...(opts.fusion
        ? { runMode: { mode: "fusion", fusion: { orchestratorProvider: cloud.id, workerProvider: "local-llama", workers: 1 } } }
        : {}),
    },
    localModels: { mode: "managed", managed: { modelId: opts.modelId ?? MODEL, port: 19091 } },
    memory: { embeddings: { enabled: opts.embeddings ?? false } },
  };
}

interface World {
  daemonUp: boolean;
  downloaded?: boolean;
  /** What a pid file would say (the early look's hint); the status itself says `daemonUp`. Defaults to `daemonUp`. */
  pidAlive?: boolean;
  stopFails?: boolean;
  /** Called as a verb is asked, before it is answered: something else happening meanwhile. */
  meanwhile?: (verb: string, nth: number, book: StandInBook) => Promise<void> | void;
}
interface Run {
  res: SwitchResult;
  calls: string[];
  file: Cfg;
  events: DaemonLifecycle[];
  count: (verb: string) => number;
  /** Where `verb` was first asked, -1 when never. */
  at: (verb: string) => number;
}

/** One switch against the stand-in: what it answered, the `atag` calls it made, and the file it left. */
async function run(start: Cfg, world: World, act: () => Promise<SwitchResult>): Promise<Run> {
  const box = { file: JSON.parse(JSON.stringify(start)) as Cfg };
  let up = world.daemonUp;
  const calls: string[] = [];
  const events: DaemonLifecycle[] = [];
  const said = (stdout: string): CliResult => ({ ok: true, stdout, stderr: "" });
  const refused = (error: string): CliResult => ({ ok: false, stdout: "", stderr: "", error });
  let book: StandInBook | null = null;
  const standIn = async (args: string[], input?: string): Promise<CliResult> => {
    const verb = args.slice(0, 2).join(" ");
    calls.push(verb);
    const nth = calls.filter((c) => c === verb).length;
    await new Promise((r) => setTimeout(r, 5));   // a process is never instant: lets side-by-side calls overlap
    if (world.meanwhile && book) await world.meanwhile(verb, nth, book);
    switch (verb) {
      case "config get":
        return said(JSON.stringify(box.file));
      case "config set":
        if (args[2] !== "-" || input === undefined) return refused("smoke stand-in: only `config set -` is answered");
        box.file = JSON.parse(input);
        return said("");
      case "models status":
        return said(up
          ? "mode: managed\ndaemon:         running (pid 999999)  http://127.0.0.1:19091\nhealth: ok\n"
          : "mode: managed\ndaemon:         stopped\nhealth: down\n");
      case "models stop":
        if (world.stopFails) return refused("smoke stand-in: the stop failed");
        up = false;
        return said("stopped\n");
      case "models start":
        up = true;
        return said("chat: started pid 4242, healthy on port 19091\n");
      case "models use": {
        const lm = (box.file.localModels ??= {});
        lm.mode = "managed";
        lm.managed = { ...(lm.managed ?? {}), modelId: args[2] };
        return said(`active model: ${args[2]}\n`);
      }
      case "models list":
        return said(`ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE\n${MODEL} | qwen | 4B | 32k | ${world.downloaded === false ? "no" : "yes"} | *\n`);
      default:
        // `models list-embeddings` included: the chat list then falls back to names.
        return refused(`smoke stand-in: no answer for \`atag ${verb}\``);
    }
  };
  const res = await withSwitchStandIn(
    standIn,
    (b) => { book = b; return act(); },
    {
      tell: (e) => { events.push(e); },
      configHint: () => box.file,
      daemonPidAlive: () => world.pidAlive ?? up,
    },
  );
  return {
    res, calls, file: box.file, events,
    count: (verb) => calls.filter((c) => c === verb).length,
    at: (verb) => calls.indexOf(verb),
  };
}

export async function checks62(_js: Js, check: Check): Promise<void> {
  const brief = (r: Run, extra: Record<string, unknown> = {}) =>
    q({ res: { ok: r.res.ok, daemon: r.res.daemon, restart: r.res.restart, error: r.res.error }, calls: r.calls, ...extra });

  // a — Local → Cloud, the model server up, hybrid recall already off: was 4 reads, 1 write, status, stop.
  const a = await run(file(), { daemonUp: true }, () => switchBackend("cloud"));
  check(
    "T62: Local → Cloud reads the config once and writes it once (was four reads), then one status and one stop",
    a.res.ok && a.res.daemon === "stopped" && a.res.restart === true
      && a.count("config get") === 1 && a.count("config set") === 1
      && a.count("models status") === 1 && a.count("models stop") === 1
      && a.file.llm?.activeTextProvider === CLOUD,
    brief(a),
  );
  check(
    "T62: the model server's status is asked beside the config read, not after the write",
    a.at("models status") >= 0 && a.at("models status") < a.at("config set"),
    q(a.calls),
  );
  check(
    "T62: the switch's stop is told as a stop on purpose — to the check's own listener, never the app's supervisor",
    q(a.events) === q(["stopping"]),
    q(a.events),
  );

  // a2 — no pid file names a live server (the agent-side duplicate): no early look, the status after the write, as before.
  const a2 = await run(file(), { daemonUp: true, pidAlive: false }, () => switchBackend("cloud"));
  check(
    "T62: when the pid files say no server, the status is asked after the write, and a server that answers is still stopped",
    a2.res.ok && a2.res.daemon === "stopped" && a2.count("models status") === 1 && a2.at("models status") > a2.at("config set")
      && a2.count("models stop") === 1,
    brief(a2),
  );

  // b — hybrid recall still on: its flag goes off after the stop, as the TUI does it.
  const b = await run(file({ embeddings: true }), { daemonUp: true }, () => switchBackend("cloud"));
  check(
    "T62: with hybrid recall on, the stop is followed by the one write that turns it off (two reads, two writes in all)",
    b.res.ok && b.res.daemon === "stopped" && b.count("config get") === 2 && b.count("config set") === 2
      && b.calls.lastIndexOf("config set") > b.at("models stop")
      && b.file.memory?.embeddings?.enabled === false && b.file.llm?.activeTextProvider === CLOUD,
    brief(b),
  );

  // b2 — off in the file the switch wrote, but another write of this process landed during the stop: the file is read again.
  const b2 = await run(file({ embeddings: false }), {
    daemonUp: true,
    meanwhile: (verb, nth) => {
      if (verb === "models stop" && nth === 1) {
        void withConfigLock(async () => { /* stands for Settings turning hybrid recall back on */ });
      }
    },
  }, () => switchBackend("cloud"));
  check(
    "T62: when another config write queued after the switch's own, the embeddings flag is read again rather than taken from the old snapshot",
    b2.res.ok && b2.res.daemon === "stopped" && b2.count("config get") === 2 && b2.at("config get") < b2.calls.lastIndexOf("config get")
      && b2.calls.lastIndexOf("config get") > b2.at("models stop"),
    brief(b2),
  );

  // c — the stop fails: the embeddings write must not follow.
  const c = await run(file({ embeddings: true }), { daemonUp: true, stopFails: true }, () => switchBackend("cloud"));
  check(
    "T62: a stop that failed is not followed by the embeddings write (one read, one write, the flag left on)",
    c.res.ok && c.res.daemon === "stop-failed" && c.count("config get") === 1 && c.count("config set") === 1
      && c.file.memory?.embeddings?.enabled === true && c.file.llm?.activeTextProvider === CLOUD,
    brief(c),
  );

  // d1 — Settings › Stop while the early status is out: the look no longer holds, the status is asked again.
  const d1 = await run(file(), {
    daemonUp: true,
    meanwhile: async (verb, nth) => {
      if (verb === "models status" && nth === 1) await stopDaemonNow();
    },
  }, () => switchBackend("cloud"));
  check(
    "T62: a stop that came while the early status was out sends the switch back to asking after its write (and it stops nothing more)",
    d1.res.ok && d1.res.daemon === "untouched" && d1.count("models status") === 2
      && d1.calls.lastIndexOf("models status") > d1.at("config set") && d1.count("models stop") === 1,
    brief(d1),
  );

  // d2 — a daemon turn began (and ended) while the early status was out: asked again too.
  const d2 = await run(file(), {
    daemonUp: true,
    meanwhile: (verb, nth, book) => {
      if (verb === "models status" && nth === 1) book.begun += 1;
    },
  }, () => switchBackend("cloud"));
  check(
    "T62: a daemon turn begun while the early status was out sends the switch back to asking after its write",
    d2.res.ok && d2.res.daemon === "stopped" && d2.count("models status") === 2
      && d2.calls.lastIndexOf("models status") > d2.at("config set") && d2.count("models stop") === 1,
    brief(d2),
  );

  // d3 — a turn on its way when the switch begins: no early look at all.
  // A turn of the check's own bookkeeping stands on its way for the whole switch.
  const d3 = await run(file(), { daemonUp: true }, () => withBusyBook(() => switchBackend("cloud")));
  check(
    "T62: with a daemon turn on its way, the Cloud switch asks no early status (it asks after its write)",
    d3.res.ok && d3.count("models status") === 1 && d3.at("models status") > d3.at("config set"),
    brief(d3),
  );

  // e — no key for the provider Cloud would pick: nothing written, nothing stopped, no status spawned.
  const e = await run(file({ embeddings: true, withKey: false }), { daemonUp: true }, () => switchBackend("cloud"));
  check(
    "T62: a Cloud switch refused for want of a key writes nothing, stops nothing and spawns no status",
    !e.res.ok && e.res.needsKey === true && e.count("config get") === 1 && e.count("config set") === 0
      && e.count("models status") === 0 && e.count("models stop") === 0 && e.file.llm?.activeTextProvider === "local-llama",
    brief(e),
  );

  // f — Fusion left for the cloud: the same one write carries the run mode.
  const f = await run(file({ fusion: true }), { daemonUp: true }, () => switchBackend("cloud"));
  check(
    "T62: Cloud picked under Fusion leaves Fusion in that same single write",
    f.res.ok && f.count("config get") === 1 && f.count("config set") === 1
      && f.file.llm?.runMode?.mode === "cloud" && f.file.llm?.activeTextProvider === CLOUD,
    brief(f, { runMode: f.file.llm?.runMode }),
  );

  // g — the Fusion orchestrator's own chip: Fusion kept, nothing stopped, no status, nothing written.
  const g = await run(file({ fusion: true }), { daemonUp: true }, () => activateProvider(CLOUD));
  check(
    "T62: re-activating the Fusion orchestrator keeps Fusion and the local model server, and spawns no status",
    g.res.ok && g.res.daemon === "untouched" && g.res.restart === false && g.count("config get") === 1
      && g.count("config set") === 0 && g.count("models status") === 0 && g.count("models stop") === 0
      && g.file.llm?.runMode?.mode === "fusion",
    brief(g, { runMode: g.file.llm?.runMode }),
  );

  // h — a provider activated by id (Settings, the provider chip): one read, one write; its status after the write.
  const h = await run(file(), { daemonUp: true }, () => activateProvider(CLOUD));
  check(
    "T62: activating a provider by id reads once and writes once, then asks the status and stops the local server",
    h.res.ok && h.res.daemon === "stopped" && h.count("config get") === 1 && h.count("config set") === 1
      && h.count("models status") === 1 && h.at("models status") > h.at("config set") && h.count("models stop") === 1
      && h.file.llm?.activeTextProvider === CLOUD,
    brief(h),
  );

  // i — a cloud model picked: its read, the model's write, then the activation's one read and write (was four reads).
  const i = await run(file(), { daemonUp: true }, () => selectCloudModel(CLOUD, "m2"));
  const iEntry = (i.file.llm?.providers ?? []).find((p: Cfg) => p.id === CLOUD);
  check(
    "T62: picking a cloud model reads the config three times (was four) and writes it twice, and lands on that model",
    i.res.ok && i.res.model === "m2" && i.res.daemon === "stopped" && i.count("config get") === 3 && i.count("config set") === 2
      && iEntry?.defaultChatModel === "m2" && i.file.llm?.activeTextProvider === CLOUD,
    brief(i),
  );

  // j — a provider with no chat model yet: the model list opens, nothing written.
  const j = await run(file({ noModelEntry: true }), { daemonUp: true }, () => activateProvider(NO_MODEL));
  check(
    "T62: activating a provider with no chat model asks for one and writes, stops and spawns nothing more",
    !j.res.ok && j.res.needsChatModel === true && j.count("config get") === 1 && j.count("config set") === 0
      && j.count("models status") === 0 && j.count("models stop") === 0,
    brief(j),
  );

  // k — Cloud → Local, the same model, its server up: was models list, 2 reads, 1 write, status.
  const k = await run(file({ active: CLOUD }), { daemonUp: true }, () => switchBackend("local"));
  check(
    "T62: Cloud → Local reads the config once and writes it once (was two reads), and starts nothing for a server that is up",
    k.res.ok && k.res.daemon === "untouched" && k.res.restart === true
      && k.count("models list") === 1 && k.count("config get") === 1 && k.count("config set") === 1
      && k.count("models status") === 1 && k.count("models start") === 0 && k.count("models stop") === 0
      && k.file.llm?.activeTextProvider === "local-llama",
    brief(k),
  );

  // l — Cloud → Local onto another model than the file's: `models use`, the route after it, the server restarted.
  const l = await run(file({ active: CLOUD, modelId: "smoke-t62-other" }), { daemonUp: true }, () => switchBackend("local"));
  check(
    "T62: Cloud → Local onto another model goes through `models use`, writes the route after it, and restarts the server",
    l.res.ok && l.res.daemon === "restarted" && l.res.restart === true && l.count("models use") === 1
      && l.at("models use") < l.calls.lastIndexOf("config set") && l.count("models stop") === 1 && l.count("models start") === 1
      && l.file.llm?.activeTextProvider === "local-llama" && l.file.localModels?.managed?.modelId === MODEL
      && q(l.events) === q(["stopping", "started"]),
    brief(l, { events: l.events }),
  );

  // m — nothing on disk: the route and the managed mode in one write (was two reads, two writes).
  const ext = file({ active: CLOUD });
  ext.localModels = { mode: "external", url: "http://127.0.0.1:8080", managed: { modelId: MODEL, port: 19091 } };
  const m = await run(ext, { daemonUp: false, downloaded: false }, () => switchBackend("local"));
  check(
    "T62: Local with no model on disk moves the route and the managed mode in one read and one write (was two of each)",
    m.res.ok && m.res.needsModel === true && m.res.restart === true
      && m.count("config get") === 1 && m.count("config set") === 1
      && m.file.llm?.activeTextProvider === "local-llama" && m.file.localModels?.mode === "managed"
      && (m.file.llm?.providers ?? []).find((p: Cfg) => p.id === "local-llama")?.url === "http://127.0.0.1:19091",
    brief(m, { localModels: m.file.localModels }),
  );
}

/** Runs `body` with a turn of the check's own daemon bookkeeping on its way the whole time. */
async function withBusyBook<T>(body: () => Promise<T>): Promise<T> {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const turn = inDaemonTurn(() => held, () => undefined);
  try {
    return await body();
  } finally {
    release();
    await turn;
  }
}
