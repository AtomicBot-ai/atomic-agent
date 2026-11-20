/**
 * OS sandbox for agent-run commands (ATO-469, network switch ATO-472).
 *
 * The shell guard and the approval gate are logical rules: they read the
 * command line and decide. A command that slips past them (a script the
 * model wrote, an alias, a tool the guard does not know) still runs with
 * every right the user has. This wraps the spawn itself, so the kernel
 * enforces the limits whatever the command line says:
 *
 * - writes only under the session's working directory, the temp
 *   folders and a short list of pure download caches; a model-supplied
 *   `cwd` never widens this;
 * - no reads of credential folders and files (`~/.ssh`, `~/.aws`,
 *   `~/.netrc`, ...) or of the agent's own state directory (its `.env`,
 *   config, tokens); a working folder inside one is opened by itself;
 * - with `network: false`, no outbound IP or local-socket connection
 *   except to loopback IP, no DNS lookups and no URL opening.
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
 *   `--unshare-net` drops the network.
 * - Windows, or Linux without `bwrap`: no sandbox is available. The
 *   caller refuses the command (Jan's rule: no sandbox, no shell) and
 *   says how to turn the mode off.
 *
 * Off by default. Turned on with `ATOMIC_AGENT_SANDBOX=workspace`; the
 * network inside it is off unless `ATOMIC_AGENT_SANDBOX_NETWORK=on`.
 * A config key and a desktop/TUI switch come next (ATO-1078).
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

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
  home?: string;
  tmp?: string;
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
 * Pure download caches a build writes to outside the project. Without
 * them `npm install`, `pip install` or `cargo build` fails inside the
 * sandbox. Only cache folders: never a tool's `bin`, `init.d` or
 * settings file, because a file planted there would run later outside
 * the sandbox with every right the user has. Relative to the home folder.
 */
export const CACHE_HOME_PATHS: readonly string[] = [
  ".npm/_cacache",
  ".npm/_logs",
  ".npm/_npx",
  ".cache/pip",
  ".cache/yarn",
  ".cache/go-build",
  ".cache/node-gyp",
  ".yarn/berry/cache",
  ".pnpm-store",
  ".bun/install/cache",
  ".cargo/registry",
  ".cargo/git",
  ".rustup/tmp",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  "Library/Caches/pip",
  "Library/Caches/Yarn",
  "Library/Caches/pnpm",
  "Library/Caches/go-build",
  "Library/Caches/node-gyp",
  "Library/Developer/Xcode/DerivedData",
];

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

/** The policy for one command run from the trusted working folders. */
export function buildOsSandboxPolicy(
  input: OsSandboxPolicyInput,
): OsSandboxPolicy {
  const home = input.home ?? homedir();
  const tmp = input.tmp ?? tmpdir();
  const work = unique(input.workspaceRoots.map((p) => real(resolve(p))));
  const writableRoots = unique([
    ...work,
    real(tmp),
    // `/tmp` is a link to `/private/tmp` on macOS; both spellings.
    ...(process.platform === "win32" ? [] : ["/tmp", real("/tmp")]),
    ...CACHE_HOME_PATHS.flatMap((p) => bothSpellings(join(home, p))),
  ]);
  const secret = SECRET_HOME_PATHS.flatMap((p) => bothSpellings(join(home, p)));
  if (input.stateDir !== undefined) {
    secret.push(...bothSpellings(resolve(input.stateDir)));
  }
  const denyRead = unique(secret);
  // A working folder (or a server's own folder) inside a denied one is
  // opened again by itself; the denied folder stays denied around it.
  const keep = unique((input.keepReadable ?? []).map((p) => real(resolve(p))));
  const insideDenied = (p: string) => denyRead.some((dir) => isInside(p, dir));
  const reopen: OsSandboxReopen[] = [
    ...work.filter(insideDenied).map((path) => ({ path, write: true })),
    ...keep
      .filter((p) => insideDenied(p) && !work.includes(p))
      .map((path) => ({ path, write: false })),
  ];
  return { writableRoots, denyRead, reopen, network: input.network };
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
 * The Seatbelt profile. Later rules win, so: allow everything, then
 * deny all writes, re-allow the writable roots, deny the secret reads,
 * reopen the folders inside them that must work, and (without network)
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

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
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
  const out = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
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
