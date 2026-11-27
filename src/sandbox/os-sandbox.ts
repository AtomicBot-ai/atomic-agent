/**
 * OS sandbox for agent-run commands (ATO-469, network switch ATO-472).
 *
 * The shell guard and the approval gate are logical rules: they read the
 * command line and decide. A command that slips past them (a script the
 * model wrote, an alias, a tool the guard does not know) still runs with
 * every right the user has. This wraps the spawn itself, so the kernel
 * enforces the limits whatever the command line says:
 *
 * - writes only under the session's working directory and the temp
 *   folders; a model-supplied `cwd` never widens this, and a working
 *   directory that is the home folder or above it is not writable at all
 *   (ATO-1651). Shared package caches in the home folder stay read-only:
 *   the tools are pointed at a private cache under temp instead
 *   (`sandbox-cache-env.ts`);
 * - no reads of credential folders and files (`~/.ssh`, `~/.aws`,
 *   `~/.netrc`, ...) or of the agent's own state directory (its `.env`,
 *   config, tokens); a working folder inside one is opened by itself;
 * - for a process that keeps its network (an MCP server), the
 *   ssh-agent socket can be hidden too (`hideSshAgent`);
 * - no writes to `.git` (but git's own data on macOS), hook folders
 *   (`core.hooksPath` too), shell rc files, `.envrc`, git's config or
 *   editor configs (`.vscode`, `.idea`) even inside the working folder:
 *   they run code later, outside the sandbox (`sandbox-protected-paths.ts`,
 *   `git-hooks-path.ts`, ATO-2471);
 * - with `network: false`, no outbound IP connection except to loopback
 *   IP, no DNS lookups and no URL opening; local sockets are all denied
 *   on macOS, and on Linux the known socket places are covered (a list:
 *   `os-sandbox-sockets.ts`).
 *
 * Same split as Codex (`workspace-write`, network off by default inside
 * it) and Jan (shell always sandboxed, Seatbelt on macOS, bubblewrap on
 * Linux). The profile is ours, written from the policy each call.
 *
 * - macOS: `/usr/bin/sandbox-exec` with a Seatbelt profile. Paths go in
 *   as `-D` parameters, never spliced into the profile text, so a folder
 *   name cannot change the policy.
 * - Linux: `bwrap` (bubblewrap) when it is installed: the root is
 *   mounted read-only, writable roots are bound back read-write, secret
 *   folders are covered with an empty tmpfs (files with `/dev/null`),
 *   `--unshare-net` drops the network; without network the known local
 *   socket places are covered too (`os-sandbox-sockets.ts`), because a
 *   socket bound to a file path outlives the network namespace.
 * - Windows, or Linux without `bwrap`: no sandbox is available. The
 *   caller refuses the command (Jan's rule: no sandbox, no shell) and
 *   says how to turn the mode off.
 *
 * Off by default. Turned on with `ATOMIC_AGENT_SANDBOX=workspace`; the
 * network inside it is off unless `ATOMIC_AGENT_SANDBOX_NETWORK=on`.
 * A config key and a desktop/TUI switch come next (ATO-1078). Stdio MCP
 * servers go through the same wrapper when the mode is on (ATO-620).
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  bwrapSocketMaskArgs,
  linuxLocalSocketMasks,
  type OsSandboxSocketMask,
} from "./os-sandbox-sockets.js";
import {
  bwrapProtectedArgs,
  findProtectedPaths,
  seatbeltProtectedWriteRule,
} from "./sandbox-protected-paths.js";
import { gitHookTargets } from "./git-hooks-path.js";

export type OsSandboxMode = "off" | "workspace";

export interface OsSandboxSettings {
  mode: OsSandboxMode;
  /** Outbound network inside the sandbox; loopback always works. */
  network: boolean;
}

export const SANDBOX_MODE_ENV = "ATOMIC_AGENT_SANDBOX";
export const SANDBOX_NETWORK_ENV = "ATOMIC_AGENT_SANDBOX_NETWORK";

/**
 * Read the switch from the agent's environment. Anything but
 * `workspace` (or its aliases) is off, so a typo never half-enables it.
 */
export function readOsSandboxSettings(
  env: NodeJS.ProcessEnv = process.env,
): OsSandboxSettings {
  const raw = (env[SANDBOX_MODE_ENV] ?? "").trim().toLowerCase();
  const mode: OsSandboxMode =
    raw === "workspace" || raw === "on" || raw === "1" || raw === "true"
      ? "workspace"
      : "off";
  const net = (env[SANDBOX_NETWORK_ENV] ?? "").trim().toLowerCase();
  return { mode, network: net === "on" || net === "1" || net === "true" };
}

export interface OsSandboxReopen {
  path: string;
  /** Writable too (a working folder), or read-only (a server's own code). */
  write: boolean;
}

export interface OsSandboxPolicy {
  /** Folders the command may write under (working folders first). */
  writableRoots: readonly string[];
  /**
   * Working folders left out of `writableRoots` because they are the
   * home folder or one of its parents (`/`, `/Users`): granting them
   * would make every dotfile, rc file and tool `bin` writable (ATO-1651).
   * Set only when one was left out, so the caller can say so.
   */
  narrowedRoots?: readonly string[];
  /**
   * The working folders among `writableRoots` (temp left out). On Linux
   * they are searched for the paths that stay read-only inside them
   * (`sandbox-protected-paths.ts`, ATO-2471).
   */
  workRoots?: readonly string[];
  /**
   * More folders and files that stay read-only inside the writable
   * roots: the folder `core.hooksPath` names and the files the git
   * config includes (`git-hooks-path.ts`, ATO-2471). Resolved paths.
   */
  protectedPaths?: readonly string[];
  /**
   * Folders and files the command may not read (credential stores,
   * agent state). Each one is listed both as named and, when it is a
   * link, as the resolved target: Seatbelt matches resolved paths.
   */
  denyRead: readonly string[];
  /**
   * Folders inside a denied one that are opened again, and only those:
   * the rest of the denied folder stays hidden. A workspace under the
   * state directory, or an MCP server's own install folder there.
   */
  reopen: readonly OsSandboxReopen[];
  network: boolean;
  /**
   * Hide the user's ssh-agent: a process that keeps its network could
   * otherwise sign with every loaded key without reading `~/.ssh`.
   * Covers the usual agent socket places (macOS launchd and `ssh-agent`
   * sockets) and the exact `SSH_AUTH_SOCK` path in `denySockets`.
   */
  hideSshAgent?: boolean;
  /**
   * Socket files that may not be read or connected to: the exact
   * `SSH_AUTH_SOCK` path, and the Docker sockets when `hideDocker` is on.
   */
  denySockets?: readonly string[];
  /**
   * Without network only: the local socket places a Linux sandbox
   * covers (ATO-1652), since `--unshare-net` leaves sockets bound to a
   * file path reachable. Seatbelt does not need them: it denies
   * `(remote unix-socket)` outright.
   */
  localSocketMasks?: readonly OsSandboxSocketMask[];
}

export interface OsSandboxPolicyInput {
  /**
   * The trusted working folders: the session's working directory and
   * any other workspace roots. Never a model-supplied `cwd`: that
   * argument is what the sandbox distrusts, so it must not widen it.
   */
  workspaceRoots: readonly string[];
  /** The agent's state directory (`config.paths.stateDir`). */
  stateDir?: string;
  network: boolean;
  /**
   * Folders that must stay readable though they sit under a denied one
   * (an MCP server installed under the state directory). Not writable.
   */
  keepReadable?: readonly string[];
  /**
   * Hide the ssh-agent socket (see `OsSandboxPolicy.hideSshAgent`).
   * `sshAuthSock` is the agent's own `SSH_AUTH_SOCK` value, hidden by
   * its exact path.
   */
  hideSshAgent?: boolean;
  sshAuthSock?: string;
  /**
   * More home-relative files or folders to hide on top of
   * `SECRET_HOME_PATHS` (an MCP server also loses `~/.npmrc` and the
   * shell rc files: `MCP_SECRET_HOME_PATHS`).
   */
  extraDenyRead?: readonly string[];
  /**
   * Hide the Docker daemon sockets (`DOCKER_SOCKET_PATHS`, plus a unix
   * `DOCKER_HOST`): whoever can talk to the daemon can start a
   * container that mounts the whole disk, which ends the sandbox.
   */
  hideDocker?: boolean;
  /** The agent's `DOCKER_HOST` value; a `unix://` one is hidden too. */
  dockerHost?: string;
  home?: string;
  tmp?: string;
  /**
   * For the Linux local-socket masks without network (ATO-1652): the
   * user's id, `XDG_RUNTIME_DIR`, and the socket variables. Default to
   * the agent's own process and environment.
   */
  uid?: number;
  runtimeDir?: string;
  socketEnv?: NodeJS.ProcessEnv;
}

/**
 * Credential folders and files a command never needs to read to do the
 * user's work. Relative to the home folder.
 */
export const SECRET_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/op",
  ".netrc",
  ".git-credentials",
  ".pypirc",
  ".password-store",
  ".zsh_history",
  ".bash_history",
  "Library/Keychains",
];

/**
 * Hidden from a sandboxed MCP server on top of `SECRET_HOME_PATHS`
 * (owner decision 18.11): npm's own config (`~/.npmrc` holds registry
 * and publish tokens) and the shell rc files, where people export keys.
 * A server that installs from a private registry with `npx` needs its
 * token another way (its own `env`, or `sandbox: false`).
 */
export const MCP_SECRET_HOME_PATHS: readonly string[] = [
  ".npmrc",
  ".zshrc",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zsh_history",
  ".bash_history",
];

/**
 * Where Docker (and the Docker-compatible runtimes) put the daemon
 * socket. `~` is the home folder. Hidden from a sandboxed MCP server
 * unless its config says `sandbox: { allowDocker: true }`.
 */
export const DOCKER_SOCKET_PATHS: readonly string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "~/.docker/run/docker.sock",
  "~/.docker/desktop/docker.sock",
  "~/.colima/default/docker.sock",
  "~/.colima/docker.sock",
  "~/.orbstack/run/docker.sock",
  "~/.rd/docker.sock",
  "~/Library/Containers/com.docker.docker/Data/docker.raw.sock",
  "~/Library/Containers/com.docker.docker/Data/docker-cli.sock",
];

/** The socket path of a `unix://` `DOCKER_HOST`, or null. */
export function dockerHostSocket(dockerHost: string | undefined): string | null {
  const value = dockerHost?.trim() ?? "";
  if (!value.startsWith("unix://")) return null;
  const path = value.slice("unix://".length);
  return isAbsolute(path) ? path : null;
}

/** The real path when it exists (Seatbelt matches resolved paths). */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** A path as named and, when it resolves elsewhere, as resolved. */
function bothSpellings(path: string): string[] {
  const resolved = real(path);
  return resolved === path ? [path] : [path, resolved];
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/**
 * A working folder too broad to be writable: the home folder itself or
 * a folder above it (`/`, `/home`, `/Users`), by either spelling.
 */
export function isTooBroadWorkspaceRoot(root: string, home: string): boolean {
  const homes = bothSpellings(resolve(home));
  const roots = bothSpellings(resolve(root));
  return roots.some((r) => homes.some((h) => isInside(h, r)));
}

/** The policy for one command run from the trusted working folders. */
export function buildOsSandboxPolicy(
  input: OsSandboxPolicyInput,
): OsSandboxPolicy {
  const home = input.home ?? homedir();
  const tmp = input.tmp ?? tmpdir();
  const named = unique(input.workspaceRoots.map((p) => resolve(p)));
  // A working directory of `~` (or `/`) is not a project: writable, it
  // would hand the command every dotfile and tool folder of the user.
  // Left out; the command still writes temp (ATO-1651). Checked on the
  // name as given, before the real path: on macOS `/home` is a link to
  // `/System/Volumes/Data/home`, and a home that does not exist (or is
  // named through a link) only matches the spelling it was given in.
  // `isTooBroadWorkspaceRoot` still compares both spellings of each.
  const narrowedRoots = named.filter((p) => isTooBroadWorkspaceRoot(p, home));
  const work = unique(named.filter((p) => !narrowedRoots.includes(p)).map(real));
  // No shared package cache in the home folder is writable: a package
  // planted there runs later outside the sandbox. The tools get a
  // private cache under temp instead (`sandbox-cache-env.ts`, ATO-1651).
  const writableRoots = unique([
    ...work,
    real(tmp),
    // `/tmp` is a link to `/private/tmp` on macOS; both spellings.
    ...(process.platform === "win32" ? [] : ["/tmp", real("/tmp")]),
  ]);
  const secret = [...SECRET_HOME_PATHS, ...(input.extraDenyRead ?? [])].flatMap((p) =>
    bothSpellings(join(home, p)),
  );
  if (input.stateDir !== undefined) {
    secret.push(...bothSpellings(resolve(input.stateDir)));
  }
  const denyRead = unique(secret);
  // A working folder (or a server's own folder) inside a denied one is
  // opened again by itself; the denied folder stays denied around it.
  // A keep-readable path never reopens a denied folder itself, nor
  // anything inside a credential folder (`~/.ssh`, keychains, ...).
  const homeSecret = SECRET_HOME_PATHS.flatMap((p) => bothSpellings(join(home, p)));
  const keep = unique((input.keepReadable ?? []).map((p) => real(resolve(p)))).filter(
    (p) => !denyRead.includes(p) && !homeSecret.some((dir) => isInside(p, dir)),
  );
  const insideDenied = (p: string) => denyRead.some((dir) => isInside(p, dir));
  const reopen: OsSandboxReopen[] = [
    ...work.filter(insideDenied).map((path) => ({ path, write: true })),
    ...keep
      .filter((p) => insideDenied(p) && !work.includes(p))
      .map((path) => ({ path, write: false })),
  ];
  const sock = input.sshAuthSock?.trim();
  const sockets: string[] =
    input.hideSshAgent === true && sock !== undefined && isAbsolute(sock)
      ? bothSpellings(resolve(sock))
      : [];
  if (input.hideDocker === true) {
    const named = DOCKER_SOCKET_PATHS.map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p));
    const fromEnv = dockerHostSocket(input.dockerHost);
    if (fromEnv !== null) named.push(fromEnv);
    sockets.push(...named.flatMap((p) => bothSpellings(p)));
  }
  const denySockets = unique(sockets);
  const localSocketMasks = input.network ? [] : networkOffSocketMasks(input, home, tmp);
  // The hook folder git really uses and the config files it includes,
  // where the command could write them (ATO-2471).
  const protectedPaths = gitHookTargets({ workRoots: work, home }).filter((p) =>
    writableRoots.some((root) => isInside(p, root)),
  );
  return {
    writableRoots,
    ...(narrowedRoots.length > 0 ? { narrowedRoots } : {}),
    workRoots: work,
    ...(protectedPaths.length > 0 ? { protectedPaths } : {}),
    denyRead,
    reopen,
    network: input.network,
    ...(input.hideSshAgent === true ? { hideSshAgent: true } : {}),
    ...(denySockets.length > 0 || input.hideSshAgent === true ? { denySockets } : {}),
    ...(localSocketMasks.length > 0 ? { localSocketMasks } : {}),
  };
}

/**
 * The socket places hidden when the network is off (ATO-1652): the
 * Linux system sockets, the runtime folder, the temp-folder sockets, the
 * Docker list, and the exact `SSH_AUTH_SOCK`, `DOCKER_HOST` and
 * `CONTAINER_HOST` paths.
 */
function networkOffSocketMasks(
  input: OsSandboxPolicyInput,
  home: string,
  tmp: string,
): OsSandboxSocketMask[] {
  const env = input.socketEnv ?? process.env;
  const uid = input.uid ?? process.getuid?.();
  const runtimeDir = input.runtimeDir ?? env.XDG_RUNTIME_DIR;
  const ssh = env.SSH_AUTH_SOCK?.trim();
  const extra = [
    ...DOCKER_SOCKET_PATHS.map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p)),
    ...(ssh !== undefined && isAbsolute(ssh) ? [ssh] : []),
    ...[dockerHostSocket(env.DOCKER_HOST), dockerHostSocket(env.CONTAINER_HOST)].filter(
      (p): p is string => p !== null,
    ),
  ].flatMap((p) => bothSpellings(p));
  return linuxLocalSocketMasks({
    tmpDirs: unique(process.platform === "win32" ? [tmp] : ["/tmp", tmp]),
    ...(uid === undefined ? {} : { uid }),
    ...(runtimeDir === undefined || runtimeDir.trim() === "" ? {} : { runtimeDir }),
    extraSockets: extra,
  });
}

export type OsSandboxWrap =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

/** Where `sandbox-exec` lives; a test can point elsewhere. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Mach services that reach outside the box without an IP socket: DNS
 * lookups (a name can carry data out) and LaunchServices (`open URL`
 * hands the URL to a browser that runs unsandboxed). Denied with the
 * network.
 */
const NETWORK_MACH_SERVICES = [
  "com.apple.mDNSResponder",
  "com.apple.dnssd.service",
  "com.apple.coreservices.launchservicesd",
  "com.apple.lsd.mapdb",
  "com.apple.lsd.modifydb",
];

/**
 * Where macOS keeps ssh-agent sockets (Seatbelt sees resolved paths, so
 * `/tmp` and `$TMPDIR` appear under `/private`).
 */
const SSH_AGENT_SOCKET_PATTERNS = [
  "^/private/tmp/com\\.apple\\.launchd\\.[^/]+/",
  "^/private/tmp/ssh-[^/]+/agent\\.[0-9]+$",
  "^/private/var/folders/[^/]+/[^/]+/T/ssh-[^/]+/agent\\.[0-9]+$",
];

/**
 * The folders between a denied folder and a path reopened inside it, the
 * denied folder included. Resolving the reopened path stats each of them
 * (Node does, for the script of a server installed under the state dir),
 * so their metadata is allowed back; listing them and reading anything
 * else in them stays denied.
 */
function reopenAncestors(policy: OsSandboxPolicy): string[] {
  const out = new Set<string>();
  for (const { path } of policy.reopen) {
    for (const denied of policy.denyRead) {
      if (path === denied || !isInside(path, denied)) continue;
      let dir = dirname(path);
      while (isInside(dir, denied)) {
        out.add(dir);
        if (dir === denied) break;
        dir = dirname(dir);
      }
    }
  }
  return [...out];
}

/**
 * The Seatbelt profile. Later rules win, so: allow everything, then
 * deny all writes, re-allow the writable roots, deny the secret reads,
 * reopen the folders inside them that must work, hide the ssh-agent
 * socket when asked (after the reopen rules), and (without network)
 * deny outbound IP and local-socket traffic, DNS and URL opening, with
 * loopback IP kept. Paths arrive as `(param "...")` values from `-D`,
 * never as text here.
 */
export function buildSeatbeltProfile(policy: OsSandboxPolicy): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const writable = policy.writableRoots.map(
    (_, i) => `(subpath (param "W${i}"))`,
  );
  lines.push(
    `(allow file-write* ${writable.join(" ")} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
  );
  if (policy.denyRead.length > 0) {
    const denied = policy.denyRead.map((_, i) => `(subpath (param "R${i}"))`);
    lines.push(`(deny file-read* file-write* ${denied.join(" ")})`);
  }
  policy.reopen.forEach((entry, i) => {
    const ops = entry.write ? "file-read* file-write*" : "file-read*";
    lines.push(`(allow ${ops} (subpath (param "O${i}")))`);
  });
  const ancestors = reopenAncestors(policy);
  if (ancestors.length > 0) {
    const literals = ancestors.map((_, i) => `(literal (param "A${i}"))`);
    lines.push(`(allow file-read-metadata ${literals.join(" ")})`);
  }
  // Git hooks and config, shell rc files, `.envrc` and editor configs
  // stay read-only inside the writable roots (ATO-2471). After every
  // rule that allows a write (the reopened folders included).
  lines.push(seatbeltProtectedWriteRule((policy.protectedPaths ?? []).map((_, i) => `P${i}`)));
  const sockets = policy.denySockets ?? [];
  if (policy.hideSshAgent === true || sockets.length > 0) {
    // After the reopen rules, so nothing reopens them. Fixed patterns,
    // no outside text: launchd's per-login agent socket, and the sockets
    // `ssh-agent` makes under `/tmp` or `$TMPDIR`; then the exact socket
    // paths (the agent's `SSH_AUTH_SOCK`, the Docker sockets).
    const agent = [
      ...(policy.hideSshAgent === true
        ? SSH_AGENT_SOCKET_PATTERNS.map((re) => `(regex #"${re}")`)
        : []),
      ...sockets.map((_, i) => `(literal (param "S${i}"))`),
    ].join(" ");
    lines.push(`(deny file-read* file-write* ${agent})`);
    lines.push(`(deny network-outbound ${agent})`);
  }
  if (!policy.network) {
    lines.push('(deny network-outbound (remote ip "*:*") (remote unix-socket))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
    const services = NETWORK_MACH_SERVICES.map((n) => `(global-name "${n}")`);
    lines.push(`(deny mach-lookup ${services.join(" ")})`);
  }
  return lines.join("\n");
}

function seatbeltArgs(
  policy: OsSandboxPolicy,
  command: string,
  args: readonly string[],
): string[] {
  const params: string[] = [];
  policy.writableRoots.forEach((dir, i) => params.push("-D", `W${i}=${dir}`));
  policy.denyRead.forEach((dir, i) => params.push("-D", `R${i}=${dir}`));
  policy.reopen.forEach((entry, i) => params.push("-D", `O${i}=${entry.path}`));
  reopenAncestors(policy).forEach((dir, i) => params.push("-D", `A${i}=${dir}`));
  (policy.denySockets ?? []).forEach((path, i) => params.push("-D", `S${i}=${path}`));
  (policy.protectedPaths ?? []).forEach((path, i) => params.push("-D", `P${i}=${path}`));
  return [...params, "-p", buildSeatbeltProfile(policy), command, ...args];
}

/** `bwrap` on PATH, or null. */
export function findBwrap(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "bwrap");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** A file, socket or other non-folder: bwrap cannot put a tmpfs on it. */
function isFile(path: string): boolean {
  try {
    return !statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Mount order matters (a later mount covers an earlier one): read-only
 * root, writable roots, then the denied paths covered (an empty tmpfs
 * on a folder, `/dev/null` on a file, since bwrap cannot mount a tmpfs
 * on a file), then the reopened folders bound back on top.
 */
function bwrapArgs(
  policy: OsSandboxPolicy,
  command: string,
  args: readonly string[],
): string[] {
  // A private pid namespace: `/proc` shows only the sandbox's own
  // processes, so `/proc/<host pid>/root` cannot reach the hidden paths.
  const out = ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc"];
  for (const dir of policy.writableRoots) {
    // A cache folder that does not exist yet cannot be bound; skipped.
    if (existsSync(dir)) out.push("--bind", dir, dir);
  }
  for (const path of policy.denyRead) {
    if (!existsSync(path)) continue;
    if (isFile(path)) out.push("--ro-bind", "/dev/null", path);
    else out.push("--tmpfs", path);
  }
  for (const entry of policy.reopen) {
    if (!existsSync(entry.path)) continue;
    out.push(entry.write ? "--bind" : "--ro-bind", entry.path, entry.path);
  }
  // Git hooks and config, shell rc files, `.envrc` and editor configs
  // found in the working folders bound back read-only, after the
  // writable and reopened binds so nothing re-opens them (ATO-2471).
  out.push(
    ...bwrapProtectedArgs(
      [...findProtectedPaths(policy.workRoots ?? []), ...(policy.protectedPaths ?? [])],
      policy.workRoots ?? [],
      policy.denyRead,
      policy.reopen.map((entry) => entry.path),
    ),
  );
  // The denied sockets (`SSH_AUTH_SOCK`, Docker) covered with `/dev/null`,
  // so a connect to them fails; the folder around each stays as it is.
  for (const path of policy.denySockets ?? []) {
    if (existsSync(path)) out.push("--ro-bind", "/dev/null", path);
  }
  // Without network, the local sockets bound to a file path too: the
  // network namespace alone leaves them reachable (ATO-1652). Never over
  // a writable root or a reopened folder.
  out.push(
    ...bwrapSocketMaskArgs(policy.localSocketMasks ?? [], [
      ...policy.writableRoots,
      ...policy.reopen.map((entry) => entry.path),
    ]),
  );
  if (!policy.network) out.push("--unshare-net");
  out.push("--die-with-parent", "--new-session", "--", command, ...args);
  return out;
}

export interface WrapOptions {
  platform?: NodeJS.Platform;
  /** `bwrap` path for Linux; looked up on PATH when omitted. */
  bwrap?: string | null;
  /** Whether `sandbox-exec` exists; checked when omitted. */
  seatbeltAvailable?: boolean;
}

/**
 * The spawn for `command args` inside the sandbox, or why there is none
 * on this machine. The caller decides what to do without one.
 */
export function wrapWithOsSandbox(
  command: string,
  args: readonly string[],
  policy: OsSandboxPolicy,
  options: WrapOptions = {},
): OsSandboxWrap {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const available = options.seatbeltAvailable ?? existsSync(SANDBOX_EXEC);
    if (!available) {
      return { ok: false, reason: `${SANDBOX_EXEC} is missing on this Mac` };
    }
    return { ok: true, command: SANDBOX_EXEC, args: seatbeltArgs(policy, command, args) };
  }
  if (platform === "linux") {
    const bwrap = options.bwrap === undefined ? findBwrap() : options.bwrap;
    if (bwrap === null) {
      return {
        ok: false,
        reason: "bubblewrap (`bwrap`) is not installed; install it with your package manager (for example `sudo apt install bubblewrap`)",
      };
    }
    return { ok: true, command: bwrap, args: bwrapArgs(policy, command, args) };
  }
  return {
    ok: false,
    reason: "the command sandbox is not available on Windows yet",
  };
}

/**
 * The one-line refusal when the sandbox is on but cannot run here.
 * Says how to turn it off, so the person is never stuck.
 */
export function formatSandboxUnavailable(reason: string): string {
  return (
    `Safe Mode is on, but the command sandbox cannot run here: ${reason}. ` +
    `The command was not run. To run commands without the sandbox, unset ${SANDBOX_MODE_ENV} (or set it to "off") and restart the agent.`
  );
}
