import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_ATTEMPTS,
  MERGE_MARKER,
  MOVED_NOTE,
  configCameFromDesktop,
  mergeGate,
  migrateDesktopState,
  readMergeMarker,
  takeStateMergeNotice,
  type MigrateDeps,
  type RunAtag,
} from "../state-migrate.js";

/**
 * ATO-416 — the one-time move of the desktop's ~/.atomic-agent-desktop into
 * the shared ~/.atomic-agent (main/state-migrate.ts). Run alone with
 * `--smoke --smoke-task=416`.
 *
 * Everything runs on throwaway directories under the OS temp folder, with a
 * stand-in `atag` written here in JS (no shell script, so the Windows smoke
 * runs it too) and stand-ins for the orphan reap and the pid probe. Nothing
 * of the operator's is read or written.
 *
 *  (a) the gate: environment-named directory, a directory other than the
 *      shared one, no earlier desktop setup, already merged, gave up;
 *  (b) COPY (the shared side has no config.json): config, keys, databases,
 *      skills and small files copied, traces and model folders moved, the
 *      backend and the logs left behind, marker and note written, the old
 *      directory's config, .env and databases byte for byte as they were;
 *  (c) idempotent: the gate stops a second run; with the marker removed a
 *      second run adds nothing twice;
 *  (d) MERGE (both sides have a config): a backup first (with a consistent
 *      copy of a database a live connection holds in WAL), the terminal wins
 *      every clash, the desktop fills only what is missing, the importer is
 *      asked for the databases;
 *  (e) a failed importer: ok:false, retried, and given up after MAX_ATTEMPTS;
 *      traces and models still move, the old directory is not marked done,
 *      and the give-up is said once in a notice;
 *  (f) a live Telegram lock in the old directory postpones the merge without
 *      counting an attempt; a terminal config newer than the agent is left
 *      unmerged with a warning;
 *  (g) the window's notice: once, then never again; the renderer asks for it.
 */

type Js = <T>(code: string) => Promise<T>;
type Check = (name: string, ok: boolean, detail?: string) => void;
type Obj = Record<string, unknown>;

const V = 77;
const show = (x: unknown) => JSON.stringify(x);
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");
const readJson = (p: string): Obj => JSON.parse(readFileSync(p, "utf8")) as Obj;
const put = (p: string, text: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

type Db = { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined }; close(): void };
type Sqlite = { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => Db };
function sqlite(): Sqlite | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:sqlite") as Sqlite;
  } catch {
    return null;
  }
}
function makeDb(path: string, rows: string[]): void {
  const sq = sqlite();
  if (!sq) { put(path, "not a database"); return; }
  const db = new sq.DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
  for (const r of rows) db.exec("INSERT INTO sessions (id) VALUES ('" + r + "')");
  db.close();
}
function rowCount(path: string): number | null {
  const sq = sqlite();
  if (!sq || !existsSync(path)) return null;
  const db = new sq.DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM sessions").get()?.["n"]);
  } finally {
    db.close();
  }
}

interface Stub {
  run: RunAtag;
  calls: Array<{ args: string[]; stateDir: string }>;
}
/** The agent, as far as the merge uses it. `config get` brings an older file up to V; `config set -` refuses a newer one, as the real one does. */
function stubAtag(opts: { importFails?: boolean; importUnknown?: boolean } = {}): Stub {
  const calls: Stub["calls"] = [];
  const run: RunAtag = (args, o) => {
    calls.push({ args, stateDir: o.stateDir });
    const cfgPath = join(o.stateDir, "config.json");
    if (args[0] === "config" && args[1] === "get") {
      const cfg: Obj = existsSync(cfgPath) ? readJson(cfgPath) : { version: V };
      if (typeof cfg["version"] !== "number" || (cfg["version"] as number) < V) cfg["version"] = V;
      return { status: 0, stdout: JSON.stringify(cfg), stderr: "" };
    }
    if (args[0] === "config" && args[1] === "set" && args[2] === "-") {
      const next = JSON.parse(o.input ?? "null") as Obj;
      if ((next["version"] as number) > V) return { status: 1, stdout: "", stderr: "config set failed: version " + String(next["version"]) + " is newer than this build understands (" + V + ")" };
      writeFileSync(cfgPath, JSON.stringify(next, null, 2));
      return { status: 0, stdout: "wrote " + cfgPath, stderr: "" };
    }
    if (args[0] === "models" && args[1] === "stop") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "import" && args[1] === "atomic-desktop") {
      if (opts.importFails) return { status: 1, stdout: "", stderr: "import failed: stand-in says no" };
      if (opts.importUnknown) return { status: 1, stdout: "", stderr: "unknown import source: atomic-desktop" };
      return {
        status: 0,
        stdout: "progress line\n" + JSON.stringify({ ok: true, sessions: { imported: 2, skipped: 0 }, tasks: { imported: 0, skipped: 0 }, notes: { imported: 1, skipped: 0 }, profileFacts: { imported: 0, skipped: 0 }, warnings: [] }),
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: "unknown command" };
  };
  return { run, calls };
}

function depsWith(stub: Stub, live: Set<number> = new Set(), reaped: string[] = []): MigrateDeps {
  let t = Date.UTC(2026, 9, 15, 12, 0, 0);
  return {
    runAtag: stub.run,
    reapServe: (p) => { reaped.push(p); },
    pidAlive: (pid) => live.has(pid),
    now: () => (t += 1000),
  };
}

/** A desktop directory as 0.0.2 left it. */
function makeLegacy(dir: string): void {
  put(join(dir, "config.json"), JSON.stringify({
    version: V,
    llm: {
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19191", baseUrl: "http://127.0.0.1:19192" },
        { id: "shared-prov", kind: "openai-compatible", baseUrl: "https://desk.invalid/v1", apiKey: "sk-desk-shared" },
        { id: "term-keyed", kind: "openai-compatible", baseUrl: "https://desk.invalid/v1", apiKey: "sk-desk-must-not-win" },
        { id: "desk-only", kind: "openai-compatible", baseUrl: "https://desk.invalid/v1", apiKey: "sk-desk-only", defaultChatModel: "m" },
      ],
      activeTextProvider: "desk-only",
    },
    mcp: { servers: [
      { name: "desk-mcp", enabled: true, transport: { type: "stdio", command: "desk" } },
      { name: "shared-mcp", enabled: false, transport: { type: "stdio", command: "desk" } },
    ] },
    localModels: {
      mode: "managed",
      managed: { port: 19191 },
      embeddings: { port: 19192, url: "http://127.0.0.1:19192", model: "embeddinggemma-2" },
      customModels: [{ id: "c-desk", filename: "a.gguf", huggingFaceUrl: "https://h.invalid/a.gguf" }],
    },
    tui: { onboarding: { desktop: true } },
    telegram: { enabled: true, ownerUserId: 42 },
    analytics: { enabled: false },
  }, null, 2));
  put(join(dir, ".env"), "AA_T416_DESK_ONLY=desk1\nAA_T416_TERM_KEY=desk-value\nOPENAI_COMPAT_API_KEY=sk-desk-compat\nATOMIC_AGENT_LLAMA_API_KEY=desk-llama\n");
  put(join(dir, "skills", "desk-skill", "SKILL.md"), "desk skill\n");
  put(join(dir, "skills", "shared-skill", "SKILL.md"), "desk version\n");
  put(join(dir, "traces", "t1.jsonl"), "{}\n");
  put(join(dir, "models", "models", "desk-model", "w.gguf"), "desk weights");
  put(join(dir, "models", "models", "shared-model", "w.gguf"), "desk copy");
  put(join(dir, "models", "backend", "llama-server"), "binary");
  put(join(dir, "agent.log"), "LEGACY LOG LINE\n");
  put(join(dir, "serve.json"), JSON.stringify({ pid: 1, port: 1, startedAt: 0 }));
  put(join(dir, "desktop-analytics.json"), JSON.stringify({ installedAt: 1 }));
  put(join(dir, "install-channel"), "desktop");
  put(join(dir, "restore", "s1", "f.json"), "{}");
  makeDb(join(dir, "sessions.sqlite"), ["d1", "d2"]);
  makeDb(join(dir, "memory.sqlite"), ["m1"]);
}

/** A terminal agent's directory with a setup of its own. */
function makeTerminal(dir: string, version = V): void {
  put(join(dir, "config.json"), JSON.stringify({
    version,
    llm: {
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:19091" },
        { id: "shared-prov", kind: "openai-compatible", baseUrl: "https://term.invalid/v1", apiKeyEnvVar: "AA_T416_UNSET_KEY" },
        { id: "term-keyed", kind: "openai-compatible", baseUrl: "https://term.invalid/v1", apiKeyEnvVar: "AA_T416_TERM_KEY" },
      ],
      activeTextProvider: "term-keyed",
      runMode: { mode: "cloud" },
    },
    mcp: { servers: [{ name: "shared-mcp", enabled: true, transport: { type: "stdio", command: "term" } }] },
    localModels: { mode: "managed", managed: { port: 19091 }, customModels: [] },
    tui: { onboarding: { terminal: true } },
    telegram: { enabled: false, ownerUserId: null },
    analytics: { enabled: true },
  }, null, 2));
  put(join(dir, ".env"), "AA_T416_TERM_KEY=term-value\nOPENAI_API_KEY=sk-term\n");
  put(join(dir, "skills", "shared-skill", "SKILL.md"), "terminal version\n");
  put(join(dir, "models", "models", "shared-model", "w.gguf"), "terminal copy");
  makeDb(join(dir, "sessions.sqlite"), ["t1"]);
}

const providers = (cfg: Obj) => ((cfg["llm"] as Obj)["providers"] as Obj[]);
const byId = (cfg: Obj, id: string) => providers(cfg).find((p) => p["id"] === id);

export async function checks416(js: Js, check: Check): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aa-t416-"));
  try {
    /* (a) the gate */
    {
      const legacy = join(root, "gate-legacy");
      const shared = join(root, "gate-shared");
      const none = join(root, "gate-none");
      makeLegacy(legacy);
      const g = (over: Partial<Parameters<typeof mergeGate>[0]>) => mergeGate({ currentDir: shared, sharedDir: shared, legacyDir: legacy, fromEnv: false, ...over }).run;
      const table = {
        runs: g({}),
        fromEnv: g({ fromEnv: true }),
        otherDir: g({ currentDir: join(root, "elsewhere") }),
        noLegacySetup: g({ legacyDir: none }),
        sameDirs: g({ legacyDir: shared }),
      };
      check("T416 (a): the gate runs only on the shared default directory with an earlier desktop setup",
        table.runs && !table.fromEnv && !table.otherDir && !table.noLegacySetup && !table.sameDirs, show(table));
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, MERGE_MARKER), JSON.stringify({ ok: false, attempts: MAX_ATTEMPTS }));
      const gaveUp = g({});
      writeFileSync(join(shared, MERGE_MARKER), JSON.stringify({ ok: false, attempts: MAX_ATTEMPTS - 1 }));
      const retries = g({});
      writeFileSync(join(shared, MERGE_MARKER), JSON.stringify({ ok: true, attempts: 1 }));
      const merged = g({});
      check("T416 (a): a failed merge is retried until MAX_ATTEMPTS, a finished one never again",
        !gaveUp && retries && !merged, show({ gaveUp, retries, merged }));
    }

    /* (b) COPY: the shared side has nothing yet */
    const legacyA = join(root, "a-legacy");
    const targetA = join(root, "a-shared");
    makeLegacy(legacyA);
    const before = {
      config: sha(join(legacyA, "config.json")),
      env: sha(join(legacyA, ".env")),
      sessions: sha(join(legacyA, "sessions.sqlite")),
      memory: sha(join(legacyA, "memory.sqlite")),
      skill: sha(join(legacyA, "skills", "desk-skill", "SKILL.md")),
    };
    const stubA = stubAtag();
    const reaped: string[] = [];
    const a = migrateDesktopState(legacyA, targetA, depsWith(stubA, new Set(), reaped));
    const ra = a.ran ? a.record : null;
    check("T416 (b): the copy finishes", !!ra && ra.ok && ra.mode === "copy", show(ra ?? a));
    check("T416 (b): it reaped the old directory's agent, and ran no models stop with no model server alive there",
      reaped.length === 1 && reaped[0] === join(legacyA, "serve.json")
        && !stubA.calls.some((c) => c.args.join(" ") === "models stop"),
      show({ reaped, calls: stubA.calls }));
    const cfgA = existsSync(join(targetA, "config.json")) ? readJson(join(targetA, "config.json")) : {};
    check("T416 (b): config.json arrives whole, keys inline",
      byId(cfgA, "desk-only")?.["apiKey"] === "sk-desk-only" && (cfgA["telegram"] as Obj | undefined)?.["ownerUserId"] === 42,
      show(cfgA["llm"]));
    const lmA = (cfgA["localModels"] ?? {}) as Obj;
    const ports = {
      managed: (lmA["managed"] as Obj | undefined)?.["port"] ?? null,
      embPort: (lmA["embeddings"] as Obj | undefined)?.["port"] ?? null,
      embUrl: (lmA["embeddings"] as Obj | undefined)?.["url"] ?? null,
      embModel: (lmA["embeddings"] as Obj | undefined)?.["model"] ?? null,
      localUrl: byId(cfgA, "local-llama")?.["url"] ?? null,
      localBase: byId(cfgA, "local-llama")?.["baseUrl"] ?? null,
    };
    check("T416 (b): the desktop-only ports 19191/19192 do not survive into the shared config",
      ports.managed === null && ports.embPort === null && ports.embUrl === null && ports.embModel === "embeddinggemma-2"
        && ports.localUrl === "http://127.0.0.1:19091" && ports.localBase === null,
      show(ports));
    check("T416 (b): the shared config is marked as the desktop's own (no 'set up in the terminal' notice)",
      configCameFromDesktop(targetA), show(readMergeMarker(targetA)?.mode));
    const envA = existsSync(join(targetA, ".env")) ? readFileSync(join(targetA, ".env"), "utf8") : "";
    check("T416 (b): .env arrives", /AA_T416_DESK_ONLY=desk1/.test(envA) && /AA_T416_TERM_KEY=desk-value/.test(envA), envA);
    const dbs = { sessions: rowCount(join(targetA, "sessions.sqlite")), memory: rowCount(join(targetA, "memory.sqlite")) };
    check("T416 (b): the databases arrive as consistent copies, no importer needed",
      existsSync(join(targetA, "sessions.sqlite")) && existsSync(join(targetA, "memory.sqlite"))
        && (dbs.sessions === null || dbs.sessions === 2) && (dbs.memory === null || dbs.memory === 1)
        && !stubA.calls.some((c) => c.args[0] === "import"),
      show({ dbs, copied: ra?.counts.databasesCopied }));
    check("T416 (b): skills, restore and the analytics flags arrive",
      existsSync(join(targetA, "skills", "desk-skill", "SKILL.md")) && existsSync(join(targetA, "skills", "shared-skill", "SKILL.md"))
        && existsSync(join(targetA, "restore", "s1", "f.json")) && existsSync(join(targetA, "desktop-analytics.json")),
      show(ra?.counts));
    check("T416 (b): traces and model folders are moved, not copied",
      existsSync(join(targetA, "traces", "t1.jsonl")) && !existsSync(join(legacyA, "traces", "t1.jsonl"))
        && existsSync(join(targetA, "models", "models", "desk-model", "w.gguf")) && !existsSync(join(legacyA, "models", "models", "desk-model")),
      show(ra?.counts));
    check("T416 (b): the backend, serve.json, install-channel and the old log stay behind",
      !existsSync(join(targetA, "models", "backend")) && !existsSync(join(targetA, "serve.json")) && !existsSync(join(targetA, "install-channel"))
        && !(existsSync(join(targetA, "agent.log")) && readFileSync(join(targetA, "agent.log"), "utf8").includes("LEGACY LOG LINE")),
      "");
    const logA = existsSync(join(targetA, "agent.log")) ? readFileSync(join(targetA, "agent.log"), "utf8") : "";
    check("T416 (b): agent.log has a WARN line with the counts", /WARN \[desktop\] state: merged .* \(mode copy; /.test(logA), logA.slice(0, 300));
    const after = {
      config: sha(join(legacyA, "config.json")),
      env: sha(join(legacyA, ".env")),
      sessions: sha(join(legacyA, "sessions.sqlite")),
      memory: sha(join(legacyA, "memory.sqlite")),
      skill: sha(join(legacyA, "skills", "desk-skill", "SKILL.md")),
    };
    check("T416 (b): the old directory keeps its config, keys, databases and skills byte for byte",
      show(before) === show(after), show({ before, after }));
    check("T416 (b): marker in the shared directory, a note in the old one",
      readMergeMarker(targetA)?.ok === true && existsSync(join(legacyA, MOVED_NOTE)) && existsSync(join(legacyA, "config.json")),
      show(readMergeMarker(targetA)));

    /* (c) idempotent */
    const gateAgain = mergeGate({ currentDir: targetA, sharedDir: targetA, legacyDir: legacyA, fromEnv: false });
    check("T416 (c): the next launch does not merge again", !gateAgain.run && /already merged/.test(gateAgain.reason), show(gateAgain));
    const resetDir = join(root, "c-reset-shared");
    mkdirSync(resetDir, { recursive: true });   // an agent reset: a clean shared directory, no marker in it
    const gateReset = mergeGate({ currentDir: resetDir, sharedDir: resetDir, legacyDir: legacyA, fromEnv: false });
    check("T416 (c): after an agent reset the old desktop data does not come back", !gateReset.run && /old directory/.test(gateReset.reason), show(gateReset));
    rmSync(join(targetA, MERGE_MARKER));
    const a2 = migrateDesktopState(legacyA, targetA, depsWith(stubAtag()));
    const r2 = a2.ran ? a2.record : null;
    const cfgA2 = readJson(join(targetA, "config.json"));
    check("T416 (c): a second run adds nothing twice",
      !!r2 && r2.ok && r2.mode === "merge" && r2.counts.providersAdded === 0 && r2.counts.envKeysAdded === 0
        && r2.counts.skillsCopied === 0 && r2.counts.modelsMoved === 0 && providers(cfgA2).length === providers(cfgA).length,
      show(r2?.counts));

    /* (g) the notice, once */
    const n1 = takeStateMergeNotice(targetA);
    const n2 = takeStateMergeNotice(targetA);
    check("T416 (g): the window is told once, in plain words",
      !!n1 && /now live with the terminal agent in /.test(n1.text) && /A backup of the earlier files is in /.test(n1.text)
        && !/—/.test(n1.text) && n2 === null,
      show({ n1, n2 }));
    check("T416 (g): the renderer asks main for it",
      await js<boolean>("!!(window.atomic && typeof window.atomic.stateMergeNotice === 'function')"));

    /* (d) MERGE: both sides have a setup */
    const legacyB = join(root, "b-legacy");
    const targetB = join(root, "b-shared");
    makeLegacy(legacyB);
    makeTerminal(targetB);
    const legacyBefore = { config: sha(join(legacyB, "config.json")), env: sha(join(legacyB, ".env")), sessions: sha(join(legacyB, "sessions.sqlite")) };
    // The terminal agent "running": an open connection holding a row in its WAL.
    const sq = sqlite();
    let live: Db | null = null;
    if (sq) {
      live = new sq.DatabaseSync(join(targetB, "sessions.sqlite"));
      live.exec("PRAGMA journal_mode=WAL");
      live.exec("INSERT INTO sessions (id) VALUES ('t2-in-wal')");
    }
    const stubB = stubAtag();
    // A model server still alive in the old directory: models stop runs there.
    put(join(legacyB, "models", "llama-server.pid"), "5151");
    let b: ReturnType<typeof migrateDesktopState> | null = null;
    try {
      b = migrateDesktopState(legacyB, targetB, depsWith(stubB, new Set([5151])));
    } finally {
      live?.close();
    }
    const rb = b && b.ran ? b.record : null;
    check("T416 (d): the merge finishes", !!rb && rb.ok && rb.mode === "merge", show(rb ?? b));
    const backup = rb?.backupDir ?? "";
    check("T416 (d): a backup first: config, .env and a consistent copy of the live database",
      !!backup && existsSync(join(backup, "config.json")) && existsSync(join(backup, ".env")) && existsSync(join(backup, "sessions.sqlite"))
        && (rowCount(join(backup, "sessions.sqlite")) ?? 2) === 2
        && (readJson(join(backup, "config.json"))["llm"] as Obj)["activeTextProvider"] === "term-keyed",
      show({ backup, rows: rowCount(join(backup, "sessions.sqlite")) }));
    const cfgB = readJson(join(targetB, "config.json"));
    const llmB = cfgB["llm"] as Obj;
    const mcpB = ((cfgB["mcp"] as Obj)["servers"] as Obj[]);
    const lmB = cfgB["localModels"] as Obj;
    const facts = {
      sharedProvKey: byId(cfgB, "shared-prov")?.["apiKey"] ?? null,
      sharedProvBase: byId(cfgB, "shared-prov")?.["baseUrl"],
      termKeyedKey: byId(cfgB, "term-keyed")?.["apiKey"] ?? null,
      deskOnlyKey: byId(cfgB, "desk-only")?.["apiKey"] ?? null,
      localUrl: byId(cfgB, "local-llama")?.["url"],
      active: llmB["activeTextProvider"],
      runMode: show(llmB["runMode"]),
      mcp: mcpB.map((s) => `${s["name"]}:${s["enabled"]}`).sort().join(","),
      port: (lmB["managed"] as Obj)["port"],
      custom: (lmB["customModels"] as Obj[]).map((m) => m["id"]).join(","),
      onboarding: show((cfgB["tui"] as Obj)["onboarding"]),
      telegramOwner: (cfgB["telegram"] as Obj)["ownerUserId"],
      analytics: (cfgB["analytics"] as Obj)["enabled"],
    };
    check("T416 (d): providers: added with their inline key, a clash keeps the terminal's entry, a keyless one takes the desktop's key",
      facts.deskOnlyKey === "sk-desk-only" && facts.termKeyedKey === null && facts.sharedProvKey === "sk-desk-shared"
        && facts.sharedProvBase === "https://term.invalid/v1" && facts.localUrl === "http://127.0.0.1:19091",
      show(facts));
    check("T416 (d): route, run mode, local models and onboarding stay the terminal's",
      facts.active === "term-keyed" && facts.runMode === show({ mode: "cloud" }) && facts.port === 19091 && facts.onboarding === show({ terminal: true }),
      show(facts));
    check("T416 (d): MCP servers and custom models are a union, the terminal winning a clash",
      facts.mcp === "desk-mcp:true,shared-mcp:true" && facts.custom === "c-desk", show(facts));
    check("T416 (d): an unpaired terminal Telegram takes the desktop's pairing; an opt-out on either side wins",
      facts.telegramOwner === 42 && facts.analytics === false, show(facts));
    const envB = readFileSync(join(targetB, ".env"), "utf8");
    check("T416 (d): .env gains the missing names only", /AA_T416_TERM_KEY=term-value/.test(envB) && !/desk-value/.test(envB) && /AA_T416_DESK_ONLY=desk1/.test(envB), envB);
    check("T416 (d): a key the terminal resolves through a chain, and the desktop's llama key, do not cross",
      !/OPENAI_COMPAT_API_KEY/.test(envB) && !/ATOMIC_AGENT_LLAMA_API_KEY/.test(envB) && /OPENAI_COMPAT_API_KEY=sk-desk-compat/.test(envA),
      envB);
    check("T416 (d): a live model server in the old directory is stopped there first",
      stubB.calls.some((c) => c.args.join(" ") === "models stop" && c.stateDir === legacyB), show(stubB.calls.map((c) => c.args.join(" "))));
    check("T416 (d): a merge into a terminal setup is not marked as the desktop's config", !configCameFromDesktop(targetB), "");
    check("T416 (d): a skill folder the terminal has keeps the terminal's copy",
      readFileSync(join(targetB, "skills", "shared-skill", "SKILL.md"), "utf8") === "terminal version\n" && existsSync(join(targetB, "skills", "desk-skill")), "");
    const imp = stubB.calls.find((c) => c.args[0] === "import");
    check("T416 (d): the chats, tasks and memory go through the agent's importer",
      !!imp && imp.args.join(" ") === "import atomic-desktop --source " + legacyB + " --json" && imp.stateDir === targetB
        && rb?.imported?.sessions?.imported === 2,
      show({ imp, imported: rb?.imported }));
    check("T416 (d): a model folder the terminal has stays in the old directory, the others move",
      readFileSync(join(targetB, "models", "models", "shared-model", "w.gguf"), "utf8") === "terminal copy"
        && existsSync(join(legacyB, "models", "models", "shared-model", "w.gguf")) && existsSync(join(targetB, "models", "models", "desk-model")),
      show(rb?.counts));
    const legacyAfter = { config: sha(join(legacyB, "config.json")), env: sha(join(legacyB, ".env")), sessions: sha(join(legacyB, "sessions.sqlite")) };
    check("T416 (d): the old directory's config, keys and chats are untouched", show(legacyBefore) === show(legacyAfter), show({ legacyBefore, legacyAfter }));
    const nB = takeStateMergeNotice(targetB);
    check("T416 (g): after a merge the notice names the backup", !!nB && nB.text.includes("pre-desktop-merge-"), show(nB));

    /* (e) a failed importer */
    const legacyE = join(root, "e-legacy");
    const targetE = join(root, "e-shared");
    makeLegacy(legacyE);
    makeTerminal(targetE);
    type Run = { ok?: boolean; attempts?: number; error?: string; gate?: string; ran?: boolean };
    const runs = [1, 2, 3].map((): Run => {
      const gate = mergeGate({ currentDir: targetE, sharedDir: targetE, legacyDir: legacyE, fromEnv: false });
      if (!gate.run) return { gate: gate.reason };
      const out = migrateDesktopState(legacyE, targetE, depsWith(stubAtag({ importFails: true })));
      return out.ran ? { ok: out.record.ok, attempts: out.record.attempts, error: out.record.error } : { ran: false };
    });
    const finalGate = mergeGate({ currentDir: targetE, sharedDir: targetE, legacyDir: legacyE, fromEnv: false });
    check("T416 (e): a failed import is ok:false with its reason, counted, and retried",
      runs.every((r, i) => r.ok === false && r.attempts === i + 1) && /import failed/.test(String(runs[0]?.error)),
      show(runs));
    check("T416 (e): after MAX_ATTEMPTS it gives up and the app carries on", !finalGate.run && /gave up/.test(finalGate.reason), show(finalGate));
    check("T416 (e): the rest still came over (traces, weights), but the old directory is not marked done",
      existsSync(join(targetE, "traces", "t1.jsonl")) && !existsSync(join(legacyE, "traces", "t1.jsonl")) && !existsSync(join(legacyE, MOVED_NOTE)),
      "");
    const nE = takeStateMergeNotice(targetE);
    check("T416 (e): a merge that gave up says so once, and names the old directory",
      !!nE && /not moved/.test(nE.title) && nE.text.includes("e-legacy") && takeStateMergeNotice(targetE) === null, show(nE));

    /* (e2) an agent without the importer, on a copy: uncounted, and the retry stays a copy */
    const legacyE2 = join(root, "e2-legacy");
    const targetE2 = join(root, "e2-shared");
    makeLegacy(legacyE2);
    mkdirSync(targetE2, { recursive: true });
    makeDb(join(targetE2, "sessions.sqlite"), ["t1"]);   // the shared side has chats but no config
    const e1 = migrateDesktopState(legacyE2, targetE2, depsWith(stubAtag({ importUnknown: true })));
    const re1 = e1.ran ? e1.record : null;
    const cfgE2 = existsSync(join(targetE2, "config.json")) ? readJson(join(targetE2, "config.json")) : {};
    check("T416 (e2): an agent without the importer fails the attempt without counting it",
      !!re1 && !re1.ok && re1.attempts === 0 && re1.mode === "copy" && mergeGate({ currentDir: targetE2, sharedDir: targetE2, legacyDir: legacyE2, fromEnv: false }).run,
      show(re1));
    check("T416 (e2): the desktop's config is already in place, so the next launch is not a first run",
      byId(cfgE2, "desk-only")?.["apiKey"] === "sk-desk-only" && configCameFromDesktop(targetE2), show(cfgE2["llm"]));
    const stubE2 = stubAtag();
    const e2 = migrateDesktopState(legacyE2, targetE2, depsWith(stubE2));
    const re2 = e2.ran ? e2.record : null;
    check("T416 (e2): the retry finishes as a copy, keeps the first backup, and does not re-merge the config",
      !!re2 && re2.ok && re2.mode === "copy" && re2.backupDir === re1?.backupDir && !!re2.backupDir
        && !stubE2.calls.some((c) => c.args[0] === "config") && stubE2.calls.some((c) => c.args[0] === "import"),
      show({ re2, calls: stubE2.calls.map((c) => c.args.join(" ")) }));

    /* (f) a second launch merging at the same time, a live Telegram poller, and a newer terminal config */
    const legacyF = join(root, "f-legacy");
    const targetF = join(root, "f-shared");
    makeLegacy(legacyF);
    makeTerminal(targetF, V + 5);
    mkdirSync(targetF, { recursive: true });
    put(join(targetF, ".desktop-merge.lock"), "4343");
    const busy = migrateDesktopState(legacyF, targetF, depsWith(stubAtag(), new Set([4343])));
    check("T416 (f): a second launch does not merge while another one is", !busy.ran && /another launch/.test(busy.reason), show(busy));
    const stale = migrateDesktopState(legacyF, targetF, depsWith(stubAtag({ importFails: true }), new Set()));
    rmSync(join(targetF, MERGE_MARKER), { force: true });
    check("T416 (f): a dead launch's lock is taken over, and released after", stale.ran && !existsSync(join(targetF, ".desktop-merge.lock")), show(stale));
    put(join(legacyF, "telegram.lock"), "4242");
    const held = migrateDesktopState(legacyF, targetF, depsWith(stubAtag(), new Set([4242])));
    check("T416 (f): a live Telegram lock postpones the merge without counting an attempt",
      !held.ran && /telegram\.lock/.test(held.reason) && !existsSync(join(targetF, MERGE_MARKER)), show(held));
    const cfgFBefore = sha(join(targetF, "config.json"));
    const stubF = stubAtag();
    const f = migrateDesktopState(legacyF, targetF, depsWith(stubF, new Set()));
    const rf = f.ran ? f.record : null;
    check("T416 (f): a terminal config newer than the agent is not merged, with a warning, and the rest goes on",
      !!rf && rf.ok && sha(join(targetF, "config.json")) === cfgFBefore
        && !stubF.calls.some((c) => c.args[0] === "config" && c.args[1] === "set")
        && rf.warnings.some((x) => /newer version/.test(x)) && existsSync(join(targetF, "skills", "desk-skill")),
      show(rf?.warnings));
    const nF = takeStateMergeNotice(targetF);
    check("T416 (f): the notice says the desktop settings were not merged and where they are",
      !!nF && /settings were not merged, because .*newer version/.test(nF.text) && nF.text.includes("f-legacy"), show(nF));
  } catch (err) {
    check("T416: its checks ran to the end", false, err instanceof Error ? err.stack ?? err.message : String(err));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
