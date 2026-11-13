// Pure helpers for the promptfoo provider: seed a temp project + state dir,
// read back what the agent left behind. No promptfoo import, so the unit
// test (workspace.test.ts) runs under the normal vitest suite.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Files larger than this are listed but not read back into the result. */
const MAX_READ_BACK_BYTES = 64 * 1024;

/**
 * The config schema version this checkout writes. A file at an older
 * version goes through the version-gated rewrites in config-file.ts
 * (memory opt-out, managed auto-update...), which the run must not depend
 * on, so the seed always claims the current one.
 */
export function currentConfigVersion(repoRoot = REPO_ROOT) {
  try {
    const schema = readFileSync(join(repoRoot, "src", "config", "config-schema.ts"), "utf8");
    const match = /export const USER_CONFIG_VERSION = (\d+);/.exec(schema);
    if (match) return Number(match[1]);
  } catch {
    // Fall through: a build without sources still accepts an older file.
  }
  return 10;
}

/**
 * Which model the agent under test talks to, from the environment:
 *   PROMPTFOO_AGENT_LLAMA_URL   a running llama-server (the MBP, a local box)
 *   OPENROUTER_API_KEY          OpenRouter, model PROMPTFOO_AGENT_MODEL
 * Returns null when neither is set: the caller reports a clean error.
 */
export function resolveTarget(env = process.env) {
  const llamaUrl = env.PROMPTFOO_AGENT_LLAMA_URL?.trim();
  if (llamaUrl) return { kind: "llama-server", url: llamaUrl };
  const key = env.OPENROUTER_API_KEY?.trim();
  if (key) {
    const model = env.PROMPTFOO_AGENT_MODEL?.trim() || "openai/gpt-4o-mini";
    return { kind: "openrouter", model };
  }
  return null;
}

/** The `<stateDir>/config.json` body for `target`. The API key stays in env. */
export function buildStateConfig(target, version = currentConfigVersion()) {
  const base = {
    version,
    log: { level: "info" },
    agent: { maxSteps: 25 },
    tracing: { trace: { enabled: true, maxBytesPerSession: 10 * 1024 * 1024 } },
  };
  if (target.kind === "llama-server") {
    return { ...base, localModels: { mode: "external", url: target.url } };
  }
  return {
    ...base,
    localModels: { mode: "external", url: "http://127.0.0.1:9" },
    llm: {
      activeTextProvider: "openrouter",
      activeEmbeddingProvider: "local-llama",
      toolTransport: "auto",
      providers: [
        { id: "local-llama", kind: "llama-server", url: "http://127.0.0.1:9" },
        { id: "openrouter", kind: "openrouter", defaultChatModel: target.model },
      ],
    },
  };
}

/** Write `files` ({ "rel/path": "body" }) under `root`; refuses to escape it. */
export function seedFiles(root, files) {
  for (const [rel, body] of Object.entries(files ?? {})) {
    const target = resolve(root, rel);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`seed path escapes the workspace: ${rel}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, String(body), "utf8");
  }
}

/** Every file under `root` (relative, forward slashes) with small bodies read back. */
export function snapshotFiles(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      out[rel] = statSync(abs).size <= MAX_READ_BACK_BYTES ? readFileSync(abs, "utf8") : null;
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** `sessionId` from the trailing JSON line `atomic-agent run` prints on stderr. */
export function sessionIdFromStderr(stderr) {
  const lines = stderr.trimEnd().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.sessionId === "string") return parsed.sessionId;
    } catch {
      // Not the summary line; keep looking upward.
    }
  }
  return null;
}

/** Tool calls in a session trace: `[{ tool, status, args? }]`, in order. */
export function toolCallsFromTrace(tracePath) {
  if (!tracePath || !existsSync(tracePath)) return [];
  const calls = [];
  for (const line of readFileSync(tracePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "tool_invocation") continue;
    calls.push({
      tool: typeof event.tool === "string" ? event.tool : "unknown",
      status: event.status === "error" ? "error" : "ok",
      args: event.args ?? null,
    });
  }
  return calls;
}
