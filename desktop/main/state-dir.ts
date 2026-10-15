/**
 * r5 item 9, ATO-416 — the desktop's state directory, resolved once.
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
 * ATO-416 — ONE DIRECTORY AGAIN. r5 item 9 gave the desktop its own
 * `~/.atomic-agent-desktop` on the user's words "None of the keys should be
 * shared between the TUI and the desktop app, at least during the testing
 * phase." That phase is over: from this release the desktop runs on the
 * terminal agent's own `~/.atomic-agent` — the same config.json, .env,
 * sessions, memory, skills and model folder — and both apps may run at
 * once. What that sharing needs is spread over the modules that need it:
 *   - the one-time move of an old desktop directory: state-migrate.ts,
 *     hooked into state-dir-boot.ts, reads LEGACY_DESKTOP_STATE_DIR below;
 *   - no private ports any more (claimDesktopPorts runs only on a directory
 *     that is NOT the terminal's — desktopOwnsItsPorts below);
 *   - quitting does not stop a model the terminal is still chatting with
 *     (model-sessions.ts, and ATOMIC_AGENT_SESSION_PARENT_PID in agentEnv);
 *   - two writers of one config.json: every whole-file write is a
 *     compare-and-swap (agent-cli.ts writeWholeConfig, `--expect-sha256`).
 *
 * PRECEDENCE, and why it is not simply "the default always wins":
 *   1. An explicitly set, absolute `ATOMIC_AGENT_STATE_DIR` — the smoke
 *      harness and every parallel lane run depend on it (main.ts's own
 *      instruction: "Run the suite with ATOMIC_AGENT_STATE_DIR pointed
 *      somewhere disposable"). Forcing the default over it would drag every
 *      concurrent run onto the operator's real config.json, sessions.sqlite
 *      and managed llama port.
 *   2. `ATOMIC_AGENT_DESKTOP_STATE_DIR` — the desktop's own override, kept
 *      so a desktop can still be pointed at a directory of its own.
 *   3. `~/.atomic-agent`, the terminal agent's directory (ATO-416; it was
 *      `~/.atomic-agent-desktop` before).
 * The terminal directory is the DEFAULT, not an override.
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

import { isAbsoluteOn, isUnder, trimTrailingSep } from "./platform.js";
import { agentAnalyticsEnv } from "./analytics/environment.js";
import { SESSION_PARENT_PID_ENV } from "./model-sessions.js";

function absoluteEnv(name: string): string | null {
  return absoluteValue(process.env[name]);
}

function absoluteValue(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // Windows: `C:\...` is absolute and `/` is not the separator.
  if (process.platform === "win32") {
    return isAbsoluteOn("win32", trimmed) ? trimTrailingSep("win32", trimmed) : null;
  }
  if (!trimmed.startsWith("/")) return null;
  // A trailing slash would make every `startsWith(DESKTOP_STATE_DIR + "/")`
  // containment test below disagree with the string the agent reports back
  // through /api/capabilities.
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** The operator's terminal-agent directory, and (ATO-416) the desktop's
 *  default too: on a default install the two are the same string. */
export const TUI_STATE_DIR = join(homedir(), ".atomic-agent");

/** ATO-416: where every desktop before this release kept its state. Read once,
 *  by the one-time migration (state-migrate.ts); nothing else opens it. */
export const LEGACY_DESKTOP_STATE_DIR = join(homedir(), ".atomic-agent-desktop");

/**
 * The resolution, as a pure function of the environment and the home
 * directory, so the suite can assert every cell of it (smoke-tasks/t116.ts)
 * rather than the one this run happens to sit in. Same rules as above; an
 * env value that is relative or blank is ignored, not half-honoured.
 */
export function resolveDesktopStateDir(env: Record<string, string | undefined>, home: string): string {
  return absoluteValue(env["ATOMIC_AGENT_STATE_DIR"])
    ?? absoluteValue(env["ATOMIC_AGENT_DESKTOP_STATE_DIR"])
    ?? join(home, ".atomic-agent");
}

/** Where the desktop's agent keeps everything. Absolute, always. */
export const DESKTOP_STATE_DIR = resolveDesktopStateDir(process.env, homedir());

/**
 * ATO-416: true when the desktop runs on the terminal agent's own directory —
 * the default install. Everything that used to keep the two apps apart (the
 * private ports, the weights link, the import offer) is skipped then.
 */
export const SHARES_TERMINAL_STATE = DESKTOP_STATE_DIR === TUI_STATE_DIR;

/**
 * Whether a directory gets the desktop's private llama ports (claimPortsIn)
 * on its first run. Never the terminal's own directory: the terminal agent
 * and the desktop share one config there, so they share one daemon on the
 * agent's own ports (19091/19092), and moving them would move the
 * terminal's too. An env-named throwaway directory still gets them, so a
 * lane run never collides with the operator's daemon.
 */
export function desktopOwnsItsPorts(stateDir: string, tuiStateDir: string): boolean {
  return stateDir !== tuiStateDir;
}

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
 * ATO-416: the default directory IS ~/.atomic-agent now, so the seed has
 * nothing to link there (seedFreshStateDir returns when the two are equal);
 * it only still matters for a desktop pointed at a directory of its own
 * through ATOMIC_AGENT_DESKTOP_STATE_DIR, which this flag also names.
 */
export const STATE_DIR_FROM_ENV =
  absoluteEnv("ATOMIC_AGENT_STATE_DIR") !== null || absoluteEnv("ATOMIC_AGENT_DESKTOP_STATE_DIR") !== null;

/**
 * The desktop's own managed llama-server port, for a directory that is NOT
 * the terminal's (desktopOwnsItsPorts). The agent's default is 19091
 * (config-schema.ts) and the operator's TUI config uses it, so such a fresh
 * directory moves off it: `<dataDir>/llama-server.pid` is private to each
 * directory, but a port is not, and two daemons cannot hold one. ATO-416: on
 * the shared default directory there is one daemon, on the agent's ports.
 */
export const DESKTOP_MANAGED_PORT = 19191;
export const DESKTOP_EMBEDDING_PORT = 19192;

/**
 * Move a freshly written config onto the desktop's own ports. Pure and
 * exported so the suite can drive it: the caller (main.ts claimDesktopPorts)
 * only runs on a genuinely fresh directory that is not the terminal's
 * (ATO-416), which a lane run never is.
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
  // Analytics: the agent tags its own events surface=desktop, with this install channel and desktop version.
  return {
    ...process.env,
    ...agentAnalyticsEnv(DESKTOP_STATE_DIR),
    ATOMIC_AGENT_STATE_DIR: DESKTOP_STATE_DIR,
    /* ATO-416: the desktop holds a model-session marker of its own under the
       managed data dir (model-sessions.ts), keyed by THIS pid. An `atag`
       child counts a marker with this pid as itself, so a `models stop` or a
       session exit run from the desktop does not read the desktop as
       "another session still using the model". */
    [SESSION_PARENT_PID_ENV]: String(process.pid),
  };
}

/** Is `p` the desktop's state directory, or inside it? */
export function underDesktopState(p: string): boolean {
  if (typeof p !== "string") return false;
  // Windows: drive paths, `\\` separators, case-insensitive (platform.ts).
  if (process.platform === "win32") return isUnder("win32", DESKTOP_STATE_DIR, p);
  if (!p.startsWith("/")) return false;
  return p === DESKTOP_STATE_DIR || p.startsWith(DESKTOP_STATE_DIR + "/");
}
