/**
 * r5 item 9 — the desktop owns its own state directory.
 *
 * THE RULE THIS OVERRIDES. The agent resolves its state directory in
 * exactly one place — `src/config/load-config.ts:112`
 * (`resolvePath(readEnv("ATOMIC_AGENT_STATE_DIR"), ENV_DEFAULTS.STATE_DIR)`)
 * — and the default is `~/.atomic-agent` (`src/config/config-schema.ts:2119`).
 * Everything else the agent owns is derived from it: config.json, .env,
 * sessions/memory/tasks.sqlite, traces/, skills/ and `<stateDir>/models`
 * (load-config.ts:198-206, :134-137). Until this module existed the desktop
 * set nothing, so `atag serve` and every `atag` subprocess it spawned wrote
 * the operator's own `~/.atomic-agent`.
 *
 * The user's words: "None of the keys should be shared between the TUI and
 * the desktop app, at least during the testing phase." So the desktop gets
 * `~/.atomic-agent-desktop`, and `~/.atomic-agent` is never written by any
 * process this app starts.
 *
 * PRECEDENCE, and why it is not simply "the desktop dir always wins":
 *   1. An explicitly set, absolute `ATOMIC_AGENT_STATE_DIR` — the smoke
 *      harness and every parallel lane run depend on it (main.ts's own
 *      instruction: "Run the suite with ATOMIC_AGENT_STATE_DIR pointed
 *      somewhere disposable"). Forcing the desktop directory over it would
 *      drag every concurrent run onto one shared config.json, one
 *      sessions.sqlite and one managed llama port.
 *   2. `ATOMIC_AGENT_DESKTOP_STATE_DIR` — the desktop's own override.
 *   3. `~/.atomic-agent-desktop`.
 * The desktop directory is the DEFAULT, not an override.
 *
 * WHY ABSOLUTE, ALWAYS. `resolvePath` (load-config.ts:57-65) expands a
 * leading `~`, keeps an absolute path, and otherwise resolves against
 * `process.cwd()` — and the desktop runs its subprocesses under three
 * different working directories, so a relative value would mean three
 * different state dirs. Two IPC handlers also require an absolute string
 * (`app:dotenvKeys` wants `startsWith("/")`, `memoryQuery` wants
 * `isAbsolute`). Hence the `startsWith("/")` test on both env overrides:
 * a relative one is ignored rather than half-honoured.
 */

import { homedir } from "node:os";
import { join } from "node:path";

function absoluteEnv(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  // A trailing slash would make every `startsWith(DESKTOP_STATE_DIR + "/")`
  // containment test below disagree with the string the agent reports back
  // through /api/capabilities.
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** The operator's terminal-agent directory. The desktop READS this (the
 *  import offer) and never writes it. */
export const TUI_STATE_DIR = join(homedir(), ".atomic-agent");

/** Where the desktop's own agent keeps everything. Absolute, always. */
export const DESKTOP_STATE_DIR =
  absoluteEnv("ATOMIC_AGENT_STATE_DIR") ??
  absoluteEnv("ATOMIC_AGENT_DESKTOP_STATE_DIR") ??
  join(homedir(), ".atomic-agent-desktop");

/**
 * True when the environment NAMED the directory, rather than it being the
 * desktop's own default.
 *
 * r5 review fix (major): this is the discrimination `state-dir-boot.ts`'s
 * seed step needs. Sharing the operator's 3.2 GB of weights by symlink is a
 * two-way door, and it is only a bargain for the directory the operator got
 * by installing this app — never for one they pointed us at because it is
 * disposable. `ATOMIC_AGENT_STATE_DIR` still WINS the resolution above (the
 * smoke harness and every parallel lane run depend on that); what it does
 * not do is inherit the default directory's link into ~/.atomic-agent.
 */
export const STATE_DIR_FROM_ENV =
  absoluteEnv("ATOMIC_AGENT_STATE_DIR") !== null || absoluteEnv("ATOMIC_AGENT_DESKTOP_STATE_DIR") !== null;

/**
 * The desktop's own managed llama-server port. The agent's default is 19091
 * (config-schema.ts) and the operator's TUI config uses it, so a fresh
 * desktop directory moves off it: `<dataDir>/llama-server.pid` is private to
 * each directory, but a port is not, and two daemons cannot hold one.
 */
export const DESKTOP_MANAGED_PORT = 19191;
export const DESKTOP_EMBEDDING_PORT = 19192;

/**
 * Move a freshly written config onto the desktop's own ports. Pure and
 * exported so the suite can drive it: the caller (main.ts claimDesktopPorts)
 * only runs on a genuinely fresh directory, which a lane run never is.
 *
 * BOTH embedding fields move, and that is the r5 review fix. The embedding
 * daemon is started, stopped and statused on `localModels.embeddings.port`
 * (src/cli/models-handlers.ts, local-models-orchestrator.ts) while the
 * embedding CLIENT's baseUrl is `localModels.embeddings.url`
 * (embedding-provider-registry.ts, and register-built-in-embedding-providers
 * honours `baseUrl ?? port`). Writing only the url left the desktop's daemon
 * spawning on the schema default 19092 — the operator's port, the exact
 * collision this function exists to prevent — while the desktop's own client
 * talked to 19192 where nothing listened. `atag config get` writes both
 * fields into a fresh file, so both are always present to move.
 *
 * Returns true when anything changed, so the caller can skip the write.
 */
export function claimPortsIn(cfg: Record<string, unknown>): boolean {
  const lm = (cfg["localModels"] ??= {}) as Record<string, unknown>;
  const managed = (lm["managed"] ??= {}) as Record<string, unknown>;
  const embeddings = (lm["embeddings"] ??= {}) as Record<string, unknown>;
  const url = `http://127.0.0.1:${DESKTOP_EMBEDDING_PORT}`;
  let changed = false;
  if (managed["port"] !== DESKTOP_MANAGED_PORT) { managed["port"] = DESKTOP_MANAGED_PORT; changed = true; }
  if (embeddings["port"] !== DESKTOP_EMBEDDING_PORT) { embeddings["port"] = DESKTOP_EMBEDDING_PORT; changed = true; }
  if (embeddings["url"] !== url) { embeddings["url"] = url; changed = true; }
  return changed;
}

/**
 * The environment every agent subprocess gets. Inheriting Electron's own
 * environment is already correct once state-dir-boot.ts has run, but
 * inheritance is one careless `env: {}` away from the failure this item
 * exists to end — so every spawn site names it.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ATOMIC_AGENT_STATE_DIR: DESKTOP_STATE_DIR };
}

/** Is `p` the desktop's state directory, or inside it? */
export function underDesktopState(p: string): boolean {
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  return p === DESKTOP_STATE_DIR || p.startsWith(DESKTOP_STATE_DIR + "/");
}
