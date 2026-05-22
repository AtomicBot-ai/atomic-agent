import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const CLI_BIN = resolve(REPO_ROOT, "dist", "cli", "index.js");

/**
 * Memory-eval llama lifecycle, adapted from
 * `eval/scripts/run-full-eval.mjs`. Calls the public CLI surface
 * (`atomic-agent models status|start|stop`) so we never reach into
 * private daemon-lifecycle internals — the same path an operator
 * would use by hand.
 *
 * Honours `ATOMIC_AGENT_EVAL_LLAMA_URL` as an explicit bypass:
 * when set, the lifecycle is a no-op and the URL is returned as-is
 * (operator owns the daemon out of band).
 *
 * Honours `ATOMIC_AGENT_EVAL_KEEP_DAEMON=1` for back-to-back
 * experiment runs.
 *
 * Throws clearly when the build is stale (CLI binary missing) —
 * `npm run build` must have happened first.
 */
export interface LlamaHandle {
  /** Base URL of the chat llama-server (e.g. `http://127.0.0.1:18991`). */
  url: string;
  /** Whether this handle was started by this process (and must be torn down). */
  startedByUs: boolean;
  /** Best-effort teardown — safe to call multiple times. */
  shutdown: () => void;
}

const log = (msg: string): void => {
  process.stderr.write(`[eval-memory:llama] ${msg}\n`);
};

function runCli(
  args: readonly string[],
  opts: { capture?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  if (!existsSync(CLI_BIN)) {
    throw new Error(
      `dist/cli/index.js missing — run \`npm run build\` first. Looking for ${CLI_BIN}`,
    );
  }
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

interface StatusParsed {
  port: number | null;
  modelId: string | null;
  health: string | null;
  daemon: string | null;
  url: string | null;
}

function parseStatus(stdout: string): StatusParsed {
  const port = stdout.match(/port\s+(\d+)|:(\d{4,5})/);
  const portValue = port ? Number(port[1] ?? port[2]) : null;
  const modelMatch = stdout.match(/active model:\s*(\S+)/);
  const healthMatch = stdout.match(/health:\s*(\S+)/);
  const daemonMatch = stdout.match(/daemon:\s*(\S+)/);
  const urlMatch = stdout.match(/http:\/\/[^\s]+/);
  return {
    port: portValue,
    modelId: modelMatch?.[1] ?? null,
    health: healthMatch?.[1] ?? null,
    daemon: daemonMatch?.[1] ?? null,
    url: urlMatch?.[0] ?? null,
  };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server did not become healthy at ${url} in ${timeoutMs}ms`);
}

/**
 * Bring up the managed llama daemon (chat + embedding if configured).
 *
 * Returns a `LlamaHandle` whose `shutdown()` is safe to call from
 * anywhere — vitest `afterAll`, process exit handlers, or signal
 * handlers. Calling `shutdown()` on a daemon **we did not start** is
 * a no-op.
 */
export async function bringUpLlama(
  opts: { healthTimeoutMs?: number } = {},
): Promise<LlamaHandle> {
  const overrideUrl = process.env.ATOMIC_AGENT_EVAL_LLAMA_URL;
  if (overrideUrl && overrideUrl.length > 0) {
    log(`using ATOMIC_AGENT_EVAL_LLAMA_URL=${overrideUrl} (skipping managed daemon control)`);
    // Don't fail eagerly here — the operator may want to start their daemon
    // after the harness; let runners decide.
    return {
      url: overrideUrl,
      startedByUs: false,
      shutdown: () => undefined,
    };
  }

  const status0 = runCli(["models", "status"], { capture: true });
  if (status0.status !== 0) {
    throw new Error(
      `\`atomic-agent models status\` failed:\n${status0.stderr || status0.stdout}`,
    );
  }
  const info = parseStatus(status0.stdout);
  if (!info.port) {
    throw new Error(`could not parse managed port from:\n${status0.stdout}`);
  }
  const baseUrl = `http://127.0.0.1:${info.port}`;
  log(`managed daemon: model=${info.modelId} port=${info.port} health=${info.health}`);

  const startedByUs = info.health !== "up";
  if (startedByUs) {
    log("daemon is down, starting (this can take 30-90s on first load)...");
    const start = runCli(["models", "start"]);
    if (start.status !== 0) {
      throw new Error(`\`atomic-agent models start\` exited with code ${start.status}`);
    }
  } else {
    log("daemon already healthy, reusing it");
  }

  await waitForHealth(baseUrl, opts.healthTimeoutMs ?? 120_000);
  log(`llama-server healthy at ${baseUrl}`);

  let tornDown = false;
  const shutdown = (): void => {
    if (tornDown) return;
    tornDown = true;
    if (!startedByUs) {
      log("daemon was already up when we started — leaving it running");
      return;
    }
    if (process.env.ATOMIC_AGENT_EVAL_KEEP_DAEMON === "1") {
      log("ATOMIC_AGENT_EVAL_KEEP_DAEMON=1 — leaving daemon up");
      return;
    }
    log("stopping managed daemon");
    try {
      runCli(["models", "stop"]);
    } catch (err) {
      log(`shutdown failed (best-effort): ${err instanceof Error ? err.message : err}`);
    }
  };

  return { url: baseUrl, startedByUs, shutdown };
}

/**
 * Probe whether the embedding daemon is reachable on the same managed
 * stack. Returns the URL when reachable, `null` otherwise. Used by E1
 * to gate the `hybrid` recall mode — when the embedding daemon is
 * down, that mode is skipped with a clear note in the report.
 */
export async function probeEmbeddingDaemon(opts?: {
  url?: string;
  timeoutMs?: number;
}): Promise<string | null> {
  // The managed lifecycle resolves chat + embedding URLs from the same
  // `<stateDir>/config.json`. Without a separate `models status
  // --embedding` flag, we lean on the operator-set override; otherwise
  // we read it from `atomic-agent llama embed-status` if it exists.
  // For v0 we accept an explicit URL parameter and try the user-config
  // default port 18992 as a fallback. This is conservative — better to
  // skip hybrid mode than to silently route to the wrong endpoint.
  const candidates: string[] = [];
  if (opts?.url) candidates.push(opts.url);
  if (process.env.ATOMIC_AGENT_EVAL_EMBED_URL) {
    candidates.push(process.env.ATOMIC_AGENT_EVAL_EMBED_URL);
  }
  candidates.push("http://127.0.0.1:18992");
  const timeoutMs = opts?.timeoutMs ?? 2_000;
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      const r = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(t);
      if (r.ok) return url;
    } catch {
      /* try next */
    }
  }
  return null;
}
