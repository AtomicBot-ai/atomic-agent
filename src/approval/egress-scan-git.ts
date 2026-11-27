/**
 * git for the egress scan (ATO-2116). `git push` and `git send-email`
 * send data out; `clone`, `fetch`, `pull` and `ls-remote` with a URL only
 * fetch. A push to a remote name is shown by the host its URL points at
 * when `resolveRemote` can read it (`git-remote-url.ts`), and as
 * `git remote "origin"` otherwise. A `-c` that touches `remote.*`,
 * `url.*`, `branch.*` or `include*`, a `--git-dir` / `--work-tree`, or a
 * `GIT_*` variable in front can change where the push goes, so the
 * remote is then never resolved. Idea from Goose's egress inspector
 * (`git push` outbound, `git clone|pull|fetch` inbound, Apache-2.0).
 */
import { hasUrlScheme, hostOfGitUrl, normaliseHost } from "./egress-host.js";
import type { EgressDestination } from "./egress-scan.js";

/**
 * Reads the URL a push to `remote` (`null`: the push default) would use,
 * from `chdir` (the `-C` folder, relative to the command's own folder)
 * when set. `null` when it cannot be read.
 */
export type GitRemoteResolver = (remote: string | null, chdir: string | undefined) => string | null;

const GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const PUSH_VALUE = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
const FETCH_LIKE = new Set(["clone", "fetch", "pull", "ls-remote"]);

function remoteEntry(remote: string | null, resolver: GitRemoteResolver | undefined, chdir: string | undefined): EgressDestination | null {
  const label = remote === null ? "the default git remote" : `git remote "${remote}"`;
  const url = resolver?.(remote, chdir) ?? null;
  const host = url === null ? null : hostOfGitUrl(url);
  if (host === "local") return null;
  return { kind: "git_remote", host, direction: "outbound", label: host ?? label };
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
      if (/^(?:remote|url|branch|include|includeif)\./i.test(value)) unresolvable = true;
    } else if (name !== "-C" && name !== "-c" && GLOBAL_VALUE.has(name)) {
      unresolvable = true;
    }
    if (eq === -1 && GLOBAL_VALUE.has(name)) i += 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const usable = unresolvable ? undefined : resolver;
  if (sub === "push") {
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
    if (repo === undefined) {
      const entry = remoteEntry(null, usable, chdir);
      return entry === null ? [] : [entry];
    }
    const entry = operandEntry(repo, "outbound");
    if (entry === "name") {
      const named = remoteEntry(repo, usable, chdir);
      return named === null ? [] : [named];
    }
    return entry === null ? [] : [entry];
  }
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
