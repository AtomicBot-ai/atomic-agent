import { onDaemonLifecycle, startsInFlight, withCliStandIn, type CliResult } from "../agent-cli.js";
import { bringUpInFlight, daemonTurnsOnTheirWay, switchBackend, type SwitchResult } from "../backend-switch.js";

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
 * when it is still on), and the cloud switch asks the model server's status
 * beside that read instead of after it.
 *
 * Checked here by counting: main's real switchBackend runs with every `atag`
 * call it makes answered by a stand-in that keeps a config in memory
 * (agent-cli withCliStandIn — the calls of this check only; the app's own
 * keep reaching the agent). The real config is never read or written, no
 * model server is stopped or started, no agent is restarted (that is
 * main.ts's applySwitch, not called here), and the model server's supervisor
 * is told nothing while it runs.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cfg = Record<string, any>;

const q = (v: unknown) => JSON.stringify(v);
const MODEL = "qwen-3.5-4b";
const CLOUD = "smoke-t62-cloud";
const NO_KEY = "smoke-t62-nokey";

/** A file on the local route, with the cloud provider configured and a key saved for it (a dummy; nothing is sent anywhere). */
function localFile(opts: { embeddings: boolean; withKey?: boolean; fusion?: boolean } = { embeddings: false }): Cfg {
  const cloud = opts.withKey === false
    ? { id: NO_KEY, kind: "openai-compatible", baseUrl: "https://smoke-t62.invalid/v1", apiKeyEnvVar: "SMOKE_T62_NO_SUCH_KEY", defaultChatModel: "m" }
    : { id: CLOUD, kind: "openai-compatible", baseUrl: "https://smoke-t62.invalid/v1", apiKey: "smoke-t62-dummy", defaultChatModel: "m" };
  return {
    llm: {
      activeTextProvider: opts.fusion ? cloud.id : "local-llama",
      providers: [{ id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" }, cloud],
      ...(opts.fusion
        ? { runMode: { mode: "fusion", fusion: { orchestratorProvider: cloud.id, workerProvider: "local-llama", workers: 1 } } }
        : {}),
    },
    localModels: { mode: "managed", managed: { modelId: MODEL, port: 19091 } },
    memory: { embeddings: { enabled: opts.embeddings } },
  };
}

interface Run { res: SwitchResult; calls: string[]; file: Cfg; count: (verb: string) => number }

/** One switch against the stand-in: what it answered, the `atag` calls it made, and the file it left. */
async function run(kind: "cloud" | "local", start: Cfg, world: { daemonUp: boolean; downloaded: boolean }): Promise<Run> {
  let file: Cfg = JSON.parse(JSON.stringify(start));
  let up = world.daemonUp;
  const calls: string[] = [];
  const said = (stdout: string): CliResult => ({ ok: true, stdout, stderr: "" });
  const refused = (error: string): CliResult => ({ ok: false, stdout: "", stderr: "", error });
  const standIn = async (args: string[], input?: string): Promise<CliResult> => {
    const verb = args.slice(0, 2).join(" ");
    calls.push(verb);
    await new Promise((r) => setTimeout(r, 5));   // a process is never instant: lets side-by-side calls overlap
    switch (verb) {
      case "config get":
        return said(JSON.stringify(file));
      case "config set":
        if (args[2] !== "-" || input === undefined) return refused("smoke stand-in: only `config set -` is answered");
        file = JSON.parse(input);
        return said("");
      case "models status":
        return said(up
          ? "mode: managed\ndaemon:         running (pid 999999)  http://127.0.0.1:19091\nhealth: ok\n"
          : "mode: managed\ndaemon:         stopped\nhealth: down\n");
      case "models stop":
        up = false;
        return said("stopped\n");
      case "models list":
        return said(`ID | FAMILY | SIZE | CONTEXT | DL | ACTIVE\n${MODEL} | qwen | 4B | 32k | ${world.downloaded ? "yes" : "no"} | *\n`);
      default:
        // `models list-embeddings` included: a failed read is not remembered, and the chat list falls back to names.
        return refused(`smoke stand-in: no answer for \`atag ${verb}\``);
    }
  };
  const hush = onDaemonLifecycle(() => {});
  try {
    const res = await withCliStandIn(standIn, () => switchBackend(kind));
    return { res, calls, file, count: (verb) => calls.filter((c) => c === verb).length };
  } finally {
    hush();
  }
}

/** No start of the app's own on its way: the cloud switch ends one (supersedeBringUp), and this check must not end a real one. */
const quiet = () => bringUpInFlight() === null && daemonTurnsOnTheirWay() === 0 && startsInFlight() === 0;

export async function checks62(_js: Js, check: Check): Promise<void> {
  const until = Date.now() + 120_000;
  while (!quiet() && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
  if (!quiet()) {
    check("T62: the app's own model server start ended, so the switch checks can run", false, "still starting after 120 s");
    return;
  }
  const brief = (r: Run) => q({ res: { ok: r.res.ok, daemon: r.res.daemon, restart: r.res.restart, error: r.res.error }, calls: r.calls });

  // Local → cloud, the model server up, hybrid recall already off: was 4 reads, 1 write, status, stop.
  const a = await run("cloud", localFile({ embeddings: false }), { daemonUp: true, downloaded: true });
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
    a.calls.indexOf("models status") >= 0 && a.calls.indexOf("models status") < a.calls.indexOf("config set"),
    q(a.calls),
  );

  // Hybrid recall still on: its flag goes off after the stop, as the TUI does it — one more read and write, and only then.
  const b = await run("cloud", localFile({ embeddings: true }), { daemonUp: true, downloaded: true });
  check(
    "T62: with hybrid recall on, the stop is followed by the one write that turns it off (two reads, two writes in all)",
    b.res.ok && b.res.daemon === "stopped" && b.count("config get") === 2 && b.count("config set") === 2
      && b.calls.lastIndexOf("config set") > b.calls.indexOf("models stop")
      && b.file.memory?.embeddings?.enabled === false && b.file.llm?.activeTextProvider === CLOUD,
    brief(b),
  );

  // Fusion left for the cloud: the same one write carries the run mode.
  const f = await run("cloud", localFile({ embeddings: false, fusion: true }), { daemonUp: true, downloaded: true });
  check(
    "T62: Cloud picked under Fusion leaves Fusion in that same single write",
    f.res.ok && f.count("config get") === 1 && f.count("config set") === 1
      && f.file.llm?.runMode?.mode === "cloud" && f.file.llm?.activeTextProvider === CLOUD,
    q({ ...JSON.parse(brief(f)), runMode: f.file.llm?.runMode }),
  );

  // No key for the provider Cloud would pick: nothing written, nothing stopped.
  const e = await run("cloud", localFile({ embeddings: true, withKey: false }), { daemonUp: true, downloaded: true });
  check(
    "T62: a Cloud switch refused for want of a key writes nothing and stops nothing",
    !e.res.ok && e.res.needsKey === true && e.count("config get") === 1 && e.count("config set") === 0
      && e.count("models stop") === 0 && e.file.llm?.activeTextProvider === "local-llama",
    brief(e),
  );

  // Cloud → local, the same model, its server up: was models list, 2 reads, 1 write, status.
  const cloudFile = localFile({ embeddings: false });
  cloudFile.llm.activeTextProvider = CLOUD;
  const c = await run("local", cloudFile, { daemonUp: true, downloaded: true });
  check(
    "T62: Cloud → Local reads the config once and writes it once (was two reads), and starts nothing for a server that is up",
    c.res.ok && c.res.daemon === "untouched" && c.res.restart === true
      && c.count("models list") === 1 && c.count("config get") === 1 && c.count("config set") === 1
      && c.count("models status") === 1 && c.count("models start") === 0 && c.count("models stop") === 0
      && c.file.llm?.activeTextProvider === "local-llama",
    brief(c),
  );

  // Nothing on disk: the route and the managed mode in one write (was two reads, two writes).
  const extFile = localFile({ embeddings: false });
  extFile.llm.activeTextProvider = CLOUD;
  extFile.localModels = { mode: "external", url: "http://127.0.0.1:8080", managed: { modelId: MODEL, port: 19091 } };
  const d = await run("local", extFile, { daemonUp: false, downloaded: false });
  check(
    "T62: Local with no model on disk moves the route and the managed mode in one read and one write (was two of each)",
    d.res.ok && d.res.needsModel === true && d.res.restart === true
      && d.count("config get") === 1 && d.count("config set") === 1
      && d.file.llm?.activeTextProvider === "local-llama" && d.file.localModels?.mode === "managed"
      && (d.file.llm?.providers ?? []).find((p: Cfg) => p.id === "local-llama")?.url === "http://127.0.0.1:19091",
    q({ ...JSON.parse(brief(d)), localModels: d.file.localModels }),
  );
}
