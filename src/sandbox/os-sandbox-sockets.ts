/**
 * Local sockets hidden from a Linux sandbox without network (ATO-1652).
 *
 * `bwrap --unshare-net` drops IP and abstract unix sockets (both live in
 * the network namespace), but a unix socket bound to a file path is
 * reached through the file system: `/var/run/docker.sock` (root on the
 * host), the rootless Docker and Podman sockets, containerd, the D-Bus
 * buses (systemd's user manager starts any unit), ssh-agent, tmux and
 * X11 stay open. A read-only bind does not stop `connect()`: the kernel
 * refuses writes on a read-only mount only for files, folders and links.
 *
 * So the known socket places are covered, like the secret folders: an
 * empty tmpfs on a folder (the user's runtime folder `/run/user/<uid>`,
 * `/tmp/.X11-unix`, `/tmp/tmux-<uid>`, `/tmp/ssh-*`), `/dev/null` on a
 * socket file. Flatpak does the same with the runtime folder: the app
 * gets its own empty `XDG_RUNTIME_DIR`, never the host's. Only paths
 * that exist are covered (bwrap fails on a missing mount target).
 *
 * This is a list, not a rule: a socket in a place not listed here stays
 * reachable by path. On x64 and arm64 hosts the seccomp filter of
 * `seccomp-unix-block.ts` closes the rest (ATO-2469): no `AF_UNIX`
 * socket can be created at all. These masks stay as a second layer and
 * as the only one on other hosts.
 *
 * macOS needs none of this: Seatbelt denies `(remote unix-socket)`.
 */
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/** A place to cover, and what to cover inside it if it cannot be. */
export interface OsSandboxSocketMask {
  path: string;
  /**
   * Known sockets inside `path`, covered one by one when the whole
   * folder cannot be (a working folder sits inside it).
   */
  inner?: readonly string[];
}

/** System-wide sockets: each lets a client act outside the sandbox. */
export const LINUX_SYSTEM_SOCKET_PATHS: readonly string[] = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/run/containerd/containerd.sock",
  "/var/run/containerd/containerd.sock",
  "/run/k3s/containerd/containerd.sock",
  "/run/podman/podman.sock",
  "/var/run/podman/podman.sock",
  "/run/crio/crio.sock",
  "/run/dbus/system_bus_socket",
  "/var/run/dbus/system_bus_socket",
  "/run/snapd.socket",
  "/run/snapd-snap.socket",
  "/run/libvirt/libvirt-sock",
  "/var/run/libvirt/libvirt-sock",
  "/var/snap/lxd/common/lxd/unix.socket",
  "/var/lib/lxd/unix.socket",
];

/**
 * Sockets inside the user's runtime folder, for when the folder itself
 * stays visible: session bus, systemd user manager, rootless Docker and
 * Podman, the GnuPG and keyring agents (the keyring one is an ssh-agent).
 */
export const RUNTIME_DIR_SOCKETS: readonly string[] = [
  "bus",
  "systemd",
  "docker.sock",
  "podman",
  "containerd-rootless",
  "gnupg",
  "keyring",
  "gcr",
  "openssh_agent",
  "ssh-agent.socket",
];

/**
 * Variables that point a client at a local socket. Dropped from the
 * environment of a command run without network, so a client fails
 * plainly instead of looking for its socket.
 */
export const LOCAL_SOCKET_ENV_VARS: readonly string[] = [
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "DOCKER_HOST",
  "CONTAINER_HOST",
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SYSTEM_BUS_ADDRESS",
  "GPG_AGENT_INFO",
];

export interface LinuxSocketMaskInput {
  /** Temp folders to look in for `ssh-*`, `tmux-<uid>` and X11 sockets. */
  tmpDirs: readonly string[];
  /** The user's id; `/run/user/<uid>` and `tmux-<uid>` use it. */
  uid?: number;
  /** The agent's `XDG_RUNTIME_DIR`. */
  runtimeDir?: string;
  /** More socket files (the Docker list, `SSH_AUTH_SOCK`, `DOCKER_HOST`). */
  extraSockets?: readonly string[];
}

function sshAgentDirs(tmp: string): string[] {
  try {
    return readdirSync(tmp)
      .filter((name) => name.startsWith("ssh-"))
      .map((name) => join(tmp, name));
  } catch {
    return [];
  }
}

/** The socket places to cover for one command without network. */
export function linuxLocalSocketMasks(input: LinuxSocketMaskInput): OsSandboxSocketMask[] {
  const out: OsSandboxSocketMask[] = [];
  const seen = new Set<string>();
  const add = (mask: OsSandboxSocketMask) => {
    if (!isAbsolute(mask.path) || seen.has(mask.path)) return;
    seen.add(mask.path);
    out.push(mask);
  };
  const runtimeDirs = [
    ...(input.runtimeDir === undefined ? [] : [input.runtimeDir.trim()]),
    ...(input.uid === undefined ? [] : [`/run/user/${input.uid}`]),
  ];
  for (const dir of runtimeDirs) {
    add({ path: dir, inner: RUNTIME_DIR_SOCKETS.map((name) => join(dir, name)) });
  }
  for (const tmp of input.tmpDirs) {
    add({ path: join(tmp, ".X11-unix") });
    add({ path: join(tmp, ".ICE-unix") });
    if (input.uid !== undefined) add({ path: join(tmp, `tmux-${input.uid}`) });
    for (const dir of sshAgentDirs(tmp)) add({ path: dir });
  }
  for (const path of [...LINUX_SYSTEM_SOCKET_PATHS, ...(input.extraSockets ?? [])]) {
    add({ path });
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function kind(path: string): "dir" | "other" | null {
  try {
    return statSync(path).isDirectory() ? "dir" : "other";
  } catch {
    return null;
  }
}

/**
 * The bwrap arguments that cover the masks: `--tmpfs` on a folder,
 * `/dev/null` on anything else. A mask that would hide a path in `keep`
 * (a writable root, a reopened folder) is not covered whole; its known
 * inner sockets are covered instead. Missing paths are skipped.
 */
export function bwrapSocketMaskArgs(
  masks: readonly OsSandboxSocketMask[],
  keep: readonly string[],
): string[] {
  const out: string[] = [];
  const cover = (path: string) => {
    if (keep.some((k) => isInside(k, path))) return false;
    const found = kind(path);
    if (found === null) return true;
    if (found === "dir") out.push("--tmpfs", path);
    else out.push("--ro-bind", "/dev/null", path);
    return true;
  };
  for (const mask of masks) {
    if (cover(mask.path)) continue;
    for (const inner of mask.inner ?? []) cover(inner);
  }
  return out;
}

/** A copy of `env` without the local-socket variables. */
export function withoutLocalSocketEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of LOCAL_SOCKET_ENV_VARS) delete out[name];
  return out;
}
