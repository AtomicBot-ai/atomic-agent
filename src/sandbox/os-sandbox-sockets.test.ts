import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bwrapSocketMaskArgs,
  LINUX_SYSTEM_SOCKET_PATHS,
  linuxLocalSocketMasks,
  LOCAL_SOCKET_ENV_VARS,
  withoutLocalSocketEnv,
} from "./os-sandbox-sockets.js";

// ATO-1652: `bwrap --unshare-net` leaves unix sockets bound to a file
// path reachable (Docker, Podman, D-Bus, ssh-agent), so a sandbox
// without network covers the known socket places.
describe("linuxLocalSocketMasks", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atomic-sbx-sock-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the runtime folder, the temp sockets and the system sockets", () => {
    mkdirSync(join(tmp, "ssh-AbC123"));
    mkdirSync(join(tmp, "not-ssh"));
    const masks = linuxLocalSocketMasks({ tmpDirs: [tmp], uid: 1000, runtimeDir: "/run/user/1000" });
    const paths = masks.map((m) => m.path);
    expect(paths).toContain("/run/user/1000");
    expect(paths).toContain(join(tmp, ".X11-unix"));
    expect(paths).toContain(join(tmp, "tmux-1000"));
    expect(paths).toContain(join(tmp, "ssh-AbC123"));
    expect(paths).not.toContain(join(tmp, "not-ssh"));
    for (const sock of ["/var/run/docker.sock", "/run/podman/podman.sock", "/run/dbus/system_bus_socket"]) {
      expect(LINUX_SYSTEM_SOCKET_PATHS).toContain(sock);
      expect(paths).toContain(sock);
    }
    // The runtime folder is listed once, with its known sockets inside.
    const runtime = masks.filter((m) => m.path === "/run/user/1000");
    expect(runtime).toHaveLength(1);
    expect(runtime[0]?.inner).toContain("/run/user/1000/bus");
    expect(runtime[0]?.inner).toContain("/run/user/1000/podman");
  });

  it("adds a custom runtime folder and extra socket files, skipping relative ones", () => {
    const masks = linuxLocalSocketMasks({
      tmpDirs: [tmp],
      runtimeDir: "/run/custom-rt",
      extraSockets: ["/home/op/agent.sock", "relative.sock"],
    });
    const paths = masks.map((m) => m.path);
    expect(paths).toContain("/run/custom-rt");
    expect(paths).toContain("/home/op/agent.sock");
    expect(paths).not.toContain("relative.sock");
  });
});

describe("bwrapSocketMaskArgs", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "atomic-sbx-mask-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("covers a folder with tmpfs and a socket file with /dev/null, skipping missing ones", () => {
    const dir = join(root, "rt");
    mkdirSync(dir);
    const sock = join(root, "docker.sock");
    writeFileSync(sock, "");
    const args = bwrapSocketMaskArgs(
      [{ path: dir }, { path: sock }, { path: join(root, "missing.sock") }],
      [],
    );
    expect(args).toEqual(["--tmpfs", dir, "--ro-bind", "/dev/null", sock]);
  });

  it("never covers a folder holding a kept path; covers its known sockets instead", () => {
    const rt = join(root, "rt");
    const work = join(rt, "project");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(rt, "bus"), "");
    mkdirSync(join(rt, "gnupg"));
    const args = bwrapSocketMaskArgs(
      [{ path: rt, inner: [join(rt, "bus"), join(rt, "gnupg"), join(rt, "absent")] }],
      [work],
    );
    expect(args).not.toContain(rt);
    expect(args).toEqual(["--ro-bind", "/dev/null", join(rt, "bus"), "--tmpfs", join(rt, "gnupg")]);
  });

  it("still covers a socket folder that sits inside a writable root", () => {
    const x11 = join(root, ".X11-unix");
    mkdirSync(x11);
    expect(bwrapSocketMaskArgs([{ path: x11 }], [root])).toEqual(["--tmpfs", x11]);
  });
});

describe("withoutLocalSocketEnv", () => {
  it("drops the socket variables and keeps the rest, without touching the input", () => {
    const env = {
      PATH: "/usr/bin",
      SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      CONTAINER_HOST: "unix:///run/user/1000/podman/podman.sock",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    };
    const out = withoutLocalSocketEnv(env);
    expect(out.PATH).toBe("/usr/bin");
    for (const name of LOCAL_SOCKET_ENV_VARS) expect(out[name]).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/ssh-x/agent.1");
  });
});
