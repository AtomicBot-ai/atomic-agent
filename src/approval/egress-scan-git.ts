/**
 * git for the egress scan (ATO-2116). `git push` and `git send-email`
 * send data out; `clone`, `fetch`, `pull` and `ls-remote` with a URL only
 * fetch. A push to a remote name is shown by the host its URL points at
 * when `resolveRemote` can read it (`git-remote-url.ts`), and as
 * `git remote "origin"` otherwise. A `-c` that touches `remote.*`,
 * `url.*`, `branch.*` or `include*`, a `--git-dir` / `--work-tree`, or a
 * `GIT_*` variable in front can change where the push goes, so the
 * remote is then never resolved; nor is it when another part of the same
 * call changes the folder or the remotes (`egress-scan.ts`). Idea from Goose's egress inspector
 * (`git push` outbound, `git clone|pull|fetch` inbound, Apache-2.0).
 */
import { hasUrlScheme, hostOfGitUrl, normaliseHost } from "./egress-host.js";
import type { EgressDestination } from "./egress-scan.js";
import { recursesFor } from "./git-submodule-push.js";

/**
 * Reads the URLs a push to `remote` (`null`: the push default) would use,
 * from `chdir` (the `-C` folder, relative to the command's own folder)
 * when set: one, or every pushurl of the remote. `null` when it cannot be
 * read.
 */
export type GitRemoteResolver = (
  remote: string | null,
  chdir: string | undefined,
) => string | readonly string[] | null;

const GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
const FETCH_LIKE = new Set(["clone", "fetch", "pull", "ls-remote"]);

/** The subcommand of `git <args>` past its global flags (`git -C x remote add` → `remote`). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) return arg;
    if (!arg.includes("=") && GLOBAL_VALUE.has(arg)) i += 1;
  }
  return undefined;
}

/** One entry per host the push goes to: git pushes to every pushurl of a remote. */
function remoteEntries(
  remote: string | null,
  resolver: GitRemoteResolver | undefined,
  chdir: string | undefined,
): EgressDestination[] {
  const label = remote === null ? "the default git remote" : `git remote "${remote}"`;
  const resolved = resolver?.(remote, chdir) ?? null;
  const urls: readonly (string | null)[] =
    resolved === null ? [null] : typeof resolved === "string" ? [resolved] : resolved.length > 0 ? resolved : [null];
  const found: EgressDestination[] = [];
  for (const url of urls) {
    const host = url === null ? null : hostOfGitUrl(url);
    if (host === "local" || found.some((entry) => entry.host === host)) continue;
    found.push({ kind: "git_remote", host, direction: "outbound", label: host ?? label });
  }
  return found;
}

/**
 * A push that also pushes the submodules (review round 2 of ATO-2528):
 * each one goes to its own remote, read from its own config, which this
 * scan does not follow. So it counts as a host nobody knows, and holds.
 */
const SUBMODULE_PUSH: EgressDestination = {
  kind: "git_remote",
  host: null,
  direction: "outbound",
  label: "the submodules' own git remotes (--recurse-submodules)",
};

/**
 * Whether the push's own flags make it recurse: the last
 * `--recurse-submodules=on-demand|only` (or a value git rejects) or
 * `--no-recurse-submodules` wins; `check` sends nothing (review round 3).
 * `undefined` when no flag says.
 */
function flagsPushSubmodules(rest: readonly string[]): boolean | undefined {
  let found: boolean | undefined;
  for (const arg of rest) {
    if (arg === "--") break;
    if (arg === "--no-recurse-submodules") found = false;
    const match = /^--recurse-submodules(?:=(.*))?$/.exec(arg);
    if (match !== null) found = recursesFor("push.recursesubmodules", match[1] ?? "on-demand");
  }
  return found;
}

function operandEntry(
  operand: string,
  direction: EgressDestination["direction"],
): EgressDestination | null | "name" {
  const host = hostOfGitUrl(operand);
  if (host === "local") return null;
  if (host !== null) return { kind: "git_remote", host, direction, label: host };
  if (hasUrlScheme(operand) || /[$`]/.test(operand)) {
    return { kind: "git_remote", host: null, direction, label: `git remote ${operand}` };
  }
  return "name";
}

/**
 * `args` are the words after `git`. `indirect` is set by the caller when
 * a `GIT_*` variable was assigned in front of the command.
 */
export function scanGit(
  args: readonly string[],
  resolver: GitRemoteResolver | undefined,
  indirect = false,
): EgressDestination[] {
  let chdir: string | undefined;
  let unresolvable = indirect;
  let alias = false;
  let submodules = false;
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) break;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
    if (name === "-C" && value !== undefined) {
      chdir = chdir === undefined || value.startsWith("/") ? value : `${chdir}/${value}`;
    } else if (name === "-c" && value !== undefined) {
      if (/^(?:remote|url|branch|include|includeif|alias)\./i.test(value)) unresolvable = true;
      const recurse = /^(push\.recursesubmodules|submodule\.recurse)(?:=(.*))?$/i.exec(value);
      // The last -c wins over every config file (review round 3).
      if (recurse !== null) submodules = recursesFor((recurse[1] ?? "").toLowerCase(), recurse[2] ?? "true");
      if (/^alias\./i.test(value)) alias = true;
    } else if (name !== "-C" && name !== "-c" && GLOBAL_VALUE.has(name)) {
      unresolvable = true;
    }
    if (eq === -1 && GLOBAL_VALUE.has(name)) i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const usable = unresolvable ? undefined : resolver;
  // `git -c alias.p="!git push https://x" p`: what runs is in the alias, not readable here.
  if (alias) {
    return [{ kind: "git_remote", host: null, direction: "outbound", label: "a git alias set on the command line" }];
  }
  if (sub === "push") {
    const found = pushDestinations(rest, usable, chdir, unresolvable);
    return (flagsPushSubmodules(rest) ?? submodules) ? [...found, SUBMODULE_PUSH] : found;
  }
  return otherDestinations(sub, rest);
}

function pushDestinations(
  rest: readonly string[],
  usable: GitRemoteResolver | undefined,
  chdir: string | undefined,
  unresolvable: boolean,
): EgressDestination[] {
  let repo: string | undefined;
  for (let k = 0; k < rest.length; k += 1) {
    const arg = rest[k]!;
    if (arg === "--") {
      repo ??= rest[k + 1];
      break;
    }
    if (arg.startsWith("--repo=")) {
      repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg === "--repo") {
      repo = rest[k + 1];
      k += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      if (PUSH_VALUE.has(arg)) k += 1;
      continue;
    }
    repo ??= arg;
    break;
  }
  if (repo === undefined) return remoteEntries(null, usable, chdir);
  const entry = operandEntry(repo, "outbound");
  if (entry === "name") return remoteEntries(repo, usable, chdir);
  // A URL or a path on the line goes through the config's `insteadOf` /
  // `pushInsteadOf` rewrites too (review round 3 of ATO-2528), so it is
  // read with the config, and is unknown where the config cannot be.
  if (entry !== null && entry.host === null) return [entry];
  if (usable !== undefined) return remoteEntries(repo, usable, chdir);
  if (unresolvable) return [{ kind: "git_remote", host: null, direction: "outbound", label: `git remote ${repo}` }];
  return entry === null ? [] : [entry];
}

/** `git send-email` and the fetch-like subcommands. */
function otherDestinations(sub: string | undefined, rest: readonly string[]): EgressDestination[] {
  if (sub === "send-email") {
    const server = rest.find((a) => a.startsWith("--smtp-server="));
    const host = server === undefined ? null : normaliseHost(server.slice("--smtp-server=".length));
    return [{ kind: "git_remote", host, direction: "outbound", label: host ?? "an email server (git send-email)" }];
  }
  if (sub !== undefined && FETCH_LIKE.has(sub)) {
    const found: EgressDestination[] = [];
    for (const arg of rest) {
      if (arg.startsWith("-")) continue;
      const entry = operandEntry(arg, "inbound");
      if (entry !== null && entry !== "name" && entry.host !== null) found.push(entry);
    }
    return found;
  }
  return [];
}
