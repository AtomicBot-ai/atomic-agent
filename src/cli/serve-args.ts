/**
 * Command line surface for `atomic-agent serve` — the flag list, the
 * help text and the parse. Split out of `serve-command.ts` so the
 * command file stays about running a server rather than describing one.
 */

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
    "  --host <h>          Listen host (default 127.0.0.1)",
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
