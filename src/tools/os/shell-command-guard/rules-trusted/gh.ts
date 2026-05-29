import type { Rule } from "../guard-types.js";

/**
 * Read-only `gh` subcommand verbs. These never mutate remote or local
 * state (output-only), so they bypass the approval gate. Anything not
 * matched here falls through to the default approval gate.
 */
const GH_READ_VERBS: ReadonlySet<string> = new Set([
  "list",
  "view",
  "status",
  "diff",
  "checks",
  "browse",
  "search",
]);

/**
 * Verbs that mutate remote or local state. Their presence anywhere in the
 * positional token stream forces the approval gate even when a read verb is
 * also present (defence in depth — e.g. a write subcommand combined with a
 * `--json view` style flag value).
 */
const GH_WRITE_VERBS: ReadonlySet<string> = new Set([
  "create",
  "merge",
  "close",
  "delete",
  "edit",
  "add",
  "remove",
  "rename",
  "clone",
  "checkout",
  "sync",
  "fork",
  "comment",
  "review",
  "ready",
  "reopen",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "transfer",
  "archive",
  "unarchive",
  "set",
  "set-default",
  "download",
  "upload",
  "cancel",
  "rerun",
  "disable",
  "enable",
  "login",
  "logout",
  "refresh",
  "token",
  "setup-git",
  "develop",
  "restore",
  "import",
  "update",
]);

/**
 * `gh api` flags that carry a request body. Their presence makes the call
 * a POST by default, so a request using any of them is never auto-approved.
 */
const GH_API_FIELD_FLAGS: ReadonlySet<string> = new Set([
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
]);

const METHOD_PREFIX = "--method=";

export const ghReadOnlyRule: Rule = {
  id: "gh.read_only",
  layer: "trusted",
  match(input) {
    if (input.cmd !== "gh") return null;
    const positionals = readPositionals(input.args);
    if (positionals.length === 0) return null;

    if (positionals[0] === "api") {
      if (!isReadOnlyGhApi(input.args)) return null;
      return {
        action: "allow",
        rule: "gh.api_read",
        reason: "gh api read-only request",
      };
    }

    if (positionals.some((word) => GH_WRITE_VERBS.has(word))) return null;
    const reads = positionals.filter((word) => GH_READ_VERBS.has(word));
    if (reads.length === 0) return null;
    return {
      action: "allow",
      rule: "gh.read_only",
      reason: `gh read-only command (${reads.join(",")})`,
    };
  },
};

function readPositionals(args: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    words.push(arg.toLowerCase());
  }
  return words;
}

function isReadOnlyGhApi(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GH_API_FIELD_FLAGS.has(arg)) return false;
    if (arg === "-X" || arg === "--method") {
      if (!isReadMethod(args[i + 1] ?? "")) return false;
      i += 1;
      continue;
    }
    if (arg.startsWith(METHOD_PREFIX)) {
      if (!isReadMethod(arg.slice(METHOD_PREFIX.length))) return false;
    }
  }
  return true;
}

function isReadMethod(value: string): boolean {
  const method = value.toUpperCase();
  return method === "GET" || method === "HEAD";
}
