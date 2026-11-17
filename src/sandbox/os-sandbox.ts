/**
 * OS sandbox for agent-run commands (ATO-469, network switch ATO-472).
 *
 * The shell guard and the approval gate are logical rules: they read the
 * command line and decide. A command that slips past them (a script the
 * model wrote, an alias, a tool the guard does not know) still runs with
 * every right the user has. This wraps the spawn itself, so the kernel
 * enforces the limits whatever the command line says:
 *
 * - writes only under the working directory, the workspace roots, the
 *   temp folders and a short list of tool caches;
 * - no reads of credential folders (`~/.ssh`, `~/.aws`, `~/.gnupg`, ...)
 *   or of the agent's own state directory (its `.env`, config, tokens),
 *   unless the working directory itself is inside it;
 * - with `network: false`, no outbound connection except to loopback.
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
 *   folders are covered with an empty tmpfs, `--unshare-net` drops the
 *   network.
 * - Windows, or Linux without `bwrap`: no sandbox is available. The
 *   caller refuses the command (Jan's rule: no sandbox, no shell) and
 *   says how to turn the mode off.
 *
 * Off by default. Turned on with `ATOMIC_AGENT_SANDBOX=workspace`; the
 * network inside it is off unless `ATOMIC_AGENT_SANDBOX_NETWORK=on`.
 * A config key and a desktop/TUI switch come next (ATO-1078).
 */
import { existsSync, realpathSync } from "node:fs";
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

export interface OsSandboxPolicy {
  /** Folders the command may write under (cwd first). */
  writableRoots: readonly string[];
  /** Folders the command may not read (credential stores, agent state). */
  denyRead: readonly string[];
  network: boolean;
}

export interface OsSandboxPolicyInput {
  cwd: string;
  /** The session's working directory and any other workspace roots. */
  workspaceRoots?: readonly string[];
  /** The agent's state directory (`config.paths.stateDir`). */
  stateDir?: string;
  network: boolean;
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
  ".netrc",
  ".git-credentials",
  ".password-store",
  "Library/Keychains",
];

/**
 * Tool caches a build writes to outside the project (npm, pip, cargo,
 * Go, Gradle, Xcode). Without them `npm install` or `cargo build` fails
 * inside the sandbox. Relative to the home folder.
 */
export const CACHE_HOME_PATHS: readonly string[] = [
  ".npm",
  ".cache",
  ".yarn",
  ".pnpm-store",
  ".bun",
  ".cargo/registry",
  ".cargo/git",
  ".rustup/tmp",
  "go/pkg",
  ".gradle",
  ".m2",
  "Library/Caches",
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

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** The policy for one command run in `cwd`. */
export function buildOsSandboxPolicy(
  input: OsSandboxPolicyInput,
): OsSandboxPolicy {
  const home = input.home ?? homedir();
  const tmp = input.tmp ?? tmpdir();
  const work = [input.cwd, ...(input.workspaceRoots ?? [])].map((p) =>
    real(resolve(p)),
  );
  const writableRoots = unique([
    ...work,
    real(tmp),
    // `/tmp` is a link to `/private/tmp` on macOS; both spellings.
    ...(process.platform === "win32" ? [] : ["/tmp", real("/tmp")]),
    ...CACHE_HOME_PATHS.map((p) => join(home, p)),
  ]);
  const secret = SECRET_HOME_PATHS.map((p) => join(home, p));
  if (input.stateDir !== undefined) secret.push(real(resolve(input.stateDir)));
  // A working folder inside a denied one (a workspace under the state
  // directory) stays readable: the deny would break the command's own
  // work. The rest of that folder stays hidden.
  const denyRead = unique(
    secret.filter((dir) => !work.some((w) => isInside(w, dir))),
  );
  return { writableRoots, denyRead, network: input.network };
}

export type OsSandboxWrap =
  | { ok: true; command: string; args: string[] }
  | { ok: false; reason: string };

/** Where `sandbox-exec` lives; a test can point elsewhere. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The Seatbelt profile. Later rules win, so: allow everything, then
 * deny all writes, re-allow the writable roots, deny the secret reads,
 * and (without network) deny outbound IP traffic except loopback.
 * Paths arrive as `(param "...")` values from `-D`, never as text here.
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
  if (!policy.network) {
    lines.push('(deny network-outbound (remote ip "*:*"))');
    lines.push('(allow network-outbound (remote ip "localhost:*"))');
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
  for (const dir of policy.denyRead) {
    if (existsSync(dir)) out.push("--tmpfs", dir);
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
