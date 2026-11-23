import { resolveStateDir } from "../config/index.js";
import { HTTP_ROLES, isHttpRole, ROLE_SCOPES, type HttpRole } from "../http/http-scopes.js";
import {
  addHttpToken,
  httpTokensPath,
  readHttpTokens,
  removeHttpToken,
} from "../http/http-token-store.js";

/**
 * ATO-583 — `atag http tokens list|add|remove`: named API tokens for
 * `atag serve`, each with a role (OpenClaw operator scopes, AnythingLLM
 * roles). The serve key stays admin; a named token gets its role's scopes.
 */
export const HTTP_HELP = [
  "Usage: atomic-agent http tokens <list|add|remove> [options]",
  "",
  "Named API tokens for `atag serve`, each with a role:",
  ...HTTP_ROLES.map((role) => `  ${role.padEnd(7)} ${ROLE_SCOPES[role].join(" + ")}`),
  "",
  "  http tokens list                        Names, roles and creation dates (never the tokens)",
  "  http tokens add <name> --role <role>    Make a token and print it once; only its hash is stored",
  "  http tokens remove <name>               Revoke a token; serve stops accepting it at once",
  "",
  "The serve API key (--api-key / ATOMIC_AGENT_API_KEY) is always admin. Named tokens",
  "apply only while serve has an API key; without one serve listens on this machine",
  "only and asks for no token. A token without the scope a route needs gets 403.",
  "Tokens live in <stateDir>/http-tokens.json (owner-only).",
].join("\n");

export interface HttpCommandDeps {
  write?: (text: string) => void;
  writeErr?: (text: string) => void;
  stateDir?: () => string;
}

export async function httpCommand(args: string[], deps: HttpCommandDeps = {}): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const writeErr = deps.writeErr ?? ((t: string) => { process.stderr.write(t); });
  const usage = (message: string): number => {
    writeErr(`http: ${message}\n\n${HTTP_HELP}\n`);
    return 2;
  };
  const [group, action, ...rest] = args;
  if (!group) return usage("missing subcommand");
  if (group === "-h" || group === "--help" || action === "-h" || action === "--help") {
    write(`${HTTP_HELP}\n`);
    return 0;
  }
  if (group !== "tokens") return usage(`unknown subcommand ${group}`);
  const stateDir = (deps.stateDir ?? resolveStateDir)();

  if (action === "list") {
    if (rest.length > 0) return usage(`unexpected argument ${rest[0]}`);
    const read = readHttpTokens(stateDir);
    if (!read.ok) {
      writeErr(`http: ${read.error} (${httpTokensPath(stateDir)})\n`);
      return 1;
    }
    if (read.tokens.length === 0) {
      write("No named tokens. Add one with: atag http tokens add <name> --role member\n");
      return 0;
    }
    for (const t of read.tokens) {
      write(`${t.name.padEnd(24)} ${t.role.padEnd(7)} ${t.createdAt}\n`);
    }
    return 0;
  }

  if (action === "add") {
    const parsed = parseAddArgs(rest);
    if ("error" in parsed) return usage(parsed.error);
    const result = addHttpToken(stateDir, parsed.name, parsed.role);
    if (!result.ok) {
      writeErr(`http: ${result.error}\n`);
      return 1;
    }
    write(`${result.token}\n`);
    writeErr(
      `Token "${parsed.name}" (${parsed.role}: ${ROLE_SCOPES[parsed.role].join(" + ")}) added. ` +
        "Copy it now: it is not shown again. Send it as `Authorization: Bearer <token>`.\n",
    );
    return 0;
  }

  if (action === "remove") {
    const [name, extra] = rest;
    if (!name) return usage("remove needs a token name");
    if (extra !== undefined) return usage(`unexpected argument ${extra}`);
    const result = removeHttpToken(stateDir, name);
    if (!result.ok) {
      writeErr(`http: ${result.error}\n`);
      return 1;
    }
    write(`Removed token "${name}".\n`);
    return 0;
  }

  return usage(action ? `unknown tokens action ${action}` : "tokens needs list, add or remove");
}

function parseAddArgs(rest: string[]): { name: string; role: HttpRole } | { error: string } {
  let name: string | undefined;
  let role: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--role") {
      role = rest[i + 1];
      i++;
    } else if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length);
    } else if (arg.startsWith("-")) {
      return { error: `unknown option ${arg}` };
    } else if (name === undefined) {
      name = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  if (!name) return { error: "add needs a token name" };
  if (role === undefined) return { error: `add needs --role (${HTTP_ROLES.join(", ")})` };
  if (!isHttpRole(role)) return { error: `unknown role ${role}: use ${HTTP_ROLES.join(", ")}` };
  return { name, role };
}
