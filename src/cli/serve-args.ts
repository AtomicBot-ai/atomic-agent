/**
 * Command line surface for `atomic-agent serve` — the flag list, the
 * help text and the parse. Split out of `serve-command.ts` so the
 * command file stays about running a server rather than describing one.
 */

import { isIP } from "node:net";
import { resolve } from "node:path";

export interface ServeArgs {
  host: string;
  port: number;
  workingDir: string;
  apiKey: string | null;
  noApproval: boolean;
  parentPid: number | null;
  noParentExit: boolean;
  reapOnly: boolean;
}

export const HELP =
  [
    "atomic-agent serve — start the OpenAI-compatible HTTP API and any enabled remote channels",
    "",
    "Usage:",
    "  atomic-agent serve [options]",
    "",
    "Options:",
    "  --host <h>          Listen host (default 127.0.0.1). A host other than loopback",
    "                      (0.0.0.0, a LAN address) needs an API key: serve refuses to start without one",
    "  --port <p>          Listen port (default 8787)",
    "  --cwd <dir>         Working directory for OS tools / sessions (default: cwd)",
    "  --api-key <k>       Require this bearer token on all routes except /health and /v1/models",
    "                      (falls back to env ATOMIC_AGENT_API_KEY when flag is omitted)",
    "  --no-approval       Force approval level 5: auto-approve every dangerous tool call (dev / trusted use only)",
    "  --parent-pid <p>    Watch this pid instead of the actual parent (for spawners that double-fork)",
    "  --no-parent-exit    Keep running after the parent exits — the way to daemonise from a shell,",
    "                      including under nohup or with & disown (or ATOMIC_AGENT_SERVE_NO_PARENT_EXIT=1)",
    "  --reap              Sweep stranded servers from earlier runs, print what was found, and exit",
    "",
    "Remote channels:",
    "  serve boots the same runtime the TUI does, so an enabled Telegram or Discord",
    "  channel — and every enabled swarm bot that has a token — runs in this process too.",
    "  This is how the bots keep answering with no TUI open; nothing here restarts the",
    "  process for you.",
    "  A channel is single-instance: the first process to start it takes a lockfile in the",
    "  state dir, and a second one reports that channel as 'already running in another",
    "  atomic-agent (pid N)' and stays down without retrying — the bot itself keeps working,",
    "  it is just served from the other process.",
    "",
    "Endpoints (authenticated unless noted):",
    "  POST /v1/chat/completions                OpenAI Chat Completions API (stream or sync)",
    "  POST /v1/chat/completions/{id}/cancel    Abort a streaming completion",
    "  GET  /v1/models                          Single-model catalog (public)",
    "  GET  /health                             Liveness + llama-server reachability (public)",
    "  GET  /api/capabilities                   Runtime wiring summary",
    "  GET|PATCH /api/config                    Read or merge-write the user config file",
    "  GET  /api/skills, GET /api/skills/{name} List or inspect installed skills",
    "  POST /api/skills/install, /uninstall     Manage installed skills",
    "  GET  /api/sessions, GET /api/sessions/{id}, DELETE /api/sessions/{id}",
    "  POST /api/sessions/{id}/steer            Fold a message into the turn already running",
    "  GET  /api/sessions/{id}/steer            Steers a turn accepted but never delivered",
    "  DELETE /api/sessions/{id}/steer          Acknowledge those: ?through={seq} and/or ?discarded={n}",
    "  POST /api/approval/resolve               Resolve a pending approval",
    "  GET  /api/events                         SSE stream of pending approval requests",
  ].join("\n") + "\n";

export function parseArgs(
  args: string[],
): ServeArgs | { help: true } | { error: string } {
  let host = "127.0.0.1";
  let port = 8787;
  let workingDir: string | null = null;
  let apiKey: string | null = null;
  let apiKeyProvided = false;
  let noApproval = false;
  let parentPid: number | null = null;
  let noParentExit = process.env.ATOMIC_AGENT_SERVE_NO_PARENT_EXIT === "1";
  let reapOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    switch (flag) {
      case "-h":
      case "--help":
        return { help: true };
      case "--host": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        host = value;
        break;
      }
      case "--port": {
        const value = args[++i];
        const parsed = value ? Number.parseInt(value, 10) : NaN;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
          return { error: "--port expects an integer in 0..65535" };
        }
        port = parsed;
        break;
      }
      case "--cwd":
      case "--working-dir": {
        const value = args[++i];
        if (!value) return { error: `${flag} requires a value` };
        workingDir = resolve(value);
        break;
      }
      case "--api-key": {
        const value = args[++i];
        if (value === undefined) return { error: "--api-key requires a value" };
        // `--api-key "$ATOMIC_AGENT_API_KEY"` with the variable unset
        // passes "": that is no key, not an empty one, so the env
        // fallback below applies and loopback still starts.
        if (value.length === 0) break;
        apiKey = value;
        apiKeyProvided = true;
        break;
      }
      case "--no-approval":
        noApproval = true;
        break;
      case "--parent-pid": {
        const value = args[++i];
        const pid = value ? Number.parseInt(value, 10) : NaN;
        // `0` and `1` would silently disable the watch rather than fail,
        // so a spawner that miscomputes a pid hears about it here.
        if (!Number.isInteger(pid) || pid < 2) {
          return { error: "--parent-pid expects a process id greater than 1" };
        }
        parentPid = pid;
        break;
      }
      case "--no-parent-exit":
        noParentExit = true;
        break;
      case "--reap":
        reapOnly = true;
        break;
      default:
        return { error: `unknown flag: ${flag}` };
    }
  }
  if (!apiKeyProvided) {
    const envKey = process.env.ATOMIC_AGENT_API_KEY;
    apiKey = envKey && envKey.length > 0 ? envKey : null;
  }
  if (apiKey !== null && apiKey.trim().length === 0) {
    return {
      error:
        "the API key is only whitespace (--api-key or ATOMIC_AGENT_API_KEY); set a real token",
    };
  }
  if (!reapOnly && apiKey === null && !isLoopbackListenHost(host)) {
    return { error: missingKeyOnNetworkError(host) };
  }
  return {
    host,
    port,
    workingDir: workingDir ?? process.cwd(),
    apiKey,
    noApproval,
    parentPid,
    noParentExit,
    reapOnly,
  };
}

/**
 * Whether a `--host` value only accepts connections from this machine.
 * Decided from the literal alone, never by a DNS lookup:
 *  - `localhost` (and `localhost.`);
 *  - an IPv4 literal in 127/8, as `net.isIP` accepts it (dotted quad
 *    only, so shorthand such as `127.1` or `127.0.0.256` is not one);
 *  - the IPv6 loopback in any spelling (`::1`, `0:0:0:0:0:0:0:1`) and
 *    an IPv4-mapped 127/8 address (`::ffff:127.0.0.1`).
 * Everything else, `0.0.0.0`, `::`, a LAN address, a hostname or a
 * numeric string that is not an IP literal, counts as reachable from
 * other machines.
 */
export function isLoopbackListenHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (h === "localhost") return true;
  const kind = isIP(h);
  if (kind === 4) return h.split(".")[0] === "127";
  if (kind === 6) {
    // The URL parser prints the canonical compressed form, so every
    // spelling of one address compares equal.
    const canonical = new URL(`http://[${h}]/`).hostname;
    return canonical === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(canonical);
  }
  return false;
}

/**
 * Serve without an API key gives whoever reaches the port the agent and
 * every tool it runs: shell commands, file writes, the config file. On a
 * network host that is anyone on the network, so the parse refuses it
 * (ATO-760); the message says how to set a key.
 */
function missingKeyOnNetworkError(host: string): string {
  return (
    `--host ${host} accepts connections from other machines, and serve without an API key ` +
    "lets anyone who reaches the port run the agent and its tools. " +
    "Set a key with --api-key <token> or the ATOMIC_AGENT_API_KEY environment variable " +
    "(for example: export ATOMIC_AGENT_API_KEY=$(openssl rand -hex 24)), " +
    "or listen on 127.0.0.1"
  );
}

/**
 * The one-line warning serve prints when it starts without a key (only
 * possible on loopback, see `parseArgs`), or `null` when it has one.
 * Loopback without a key keeps working (scripts on the same machine rely
 * on it), but any program on this machine can then drive the agent.
 */
export function serveAuthWarning(args: Pick<ServeArgs, "apiKey">): string | null {
  if (args.apiKey !== null) return null;
  return (
    "[atomic-agent] serve: no API key, so any program on this machine can run the agent and its tools; " +
    "pass --api-key <token> or set ATOMIC_AGENT_API_KEY\n"
  );
}
