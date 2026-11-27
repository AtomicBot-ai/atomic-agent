import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startCommandJob } from "./command-job.js";
import { buildOsSandboxPolicy, findBwrap, wrapWithOsSandbox } from "./os-sandbox.js";
import { unixSocketBlockProgram } from "./seccomp-unix-block.js";

/**
 * ATO-2469: without network the Linux sandbox also gets a seccomp filter
 * that refuses `socket(AF_UNIX)`, so a socket file the path masks of
 * ATO-1652 do not know about (one in the working folder, a daemon's
 * socket in some other folder) cannot be reached either.
 */

function policy(network: boolean, work = "/home/op/project") {
  return buildOsSandboxPolicy({
    workspaceRoots: [work],
    network,
    home: "/home/op",
    tmp: "/var/tmp-op",
    uid: 4242,
    runtimeDir: "/run/user/4242",
    socketEnv: {},
  });
}

function linux(network: boolean, arch = "x64") {
  const w = wrapWithOsSandbox("/bin/sh", ["-c", "ls"], policy(network), {
    platform: "linux",
    bwrap: "/usr/bin/bwrap",
    arch,
  });
  if (!w.ok) throw new Error(w.reason);
  return w;
}

describe("bwrap seccomp without network (ATO-2469)", () => {
  it("passes the AF_UNIX filter on fd 3, before the command", () => {
    const w = linux(false);
    const at = w.args.indexOf("--seccomp");
    expect(at).toBeGreaterThan(-1);
    expect(w.args[at + 1]).toBe("3");
    expect(at).toBeLessThan(w.args.indexOf("--"));
    expect(w.fd3Input?.equals(unixSocketBlockProgram("x64", "LE") as Buffer)).toBe(true);
  });

  it("does the same on an arm64 host", () => {
    const w = linux(false, "arm64");
    expect(w.args).toContain("--seccomp");
    expect(w.fd3Input).toBeDefined();
  });

  it("adds no filter when the network is on", () => {
    const w = linux(true);
    expect(w.args).not.toContain("--seccomp");
    expect(w.fd3Input).toBeUndefined();
  });

  it("falls back to the path masks alone on a host with no program", () => {
    const w = linux(false, "riscv64");
    expect(w.args).not.toContain("--seccomp");
    expect(w.fd3Input).toBeUndefined();
    expect(w.args).toContain("--unshare-net");
  });

  it("never asks Seatbelt for fd 3: macOS denies unix sockets in the profile", () => {
    const w = wrapWithOsSandbox("ls", [], policy(false), { platform: "darwin", seatbeltAvailable: true });
    if (!w.ok) throw new Error(w.reason);
    expect(w.fd3Input).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("startCommandJob fd3Input", () => {
  it("hands the bytes to the child on fd 3 and closes the pipe", async () => {
    const job = startCommandJob("sh", ["-c", "cat <&3"], {
      cwd: process.cwd(),
      fd3Input: Buffer.from("seccomp-bytes"),
    });
    expect(await job.waitFor(10_000)).toBe("exited");
    expect(job.output().stdout).toBe("seccomp-bytes");
    expect(job.exited()?.exitCode).toBe(0);
  });

  it("opens no fd 3 unless asked", async () => {
    const job = startCommandJob("sh", ["-c", "cat <&3 2>/dev/null || echo none"], {
      cwd: process.cwd(),
    });
    expect(await job.waitFor(10_000)).toBe("exited");
    expect(job.output().stdout).toContain("none");
  });
});

// The bypass, on a real bubblewrap: a socket in the working folder (a
// writable root, so no path mask covers it) is listened on outside the
// sandbox, and a sandboxed `node` tries to connect to it.
const realBwrap = process.platform === "linux" ? findBwrap() : null;
describe.skipIf(realBwrap === null || unixSocketBlockProgram() === null)(
  "a sandboxed command cannot reach an unlisted unix socket (ATO-2469, real bwrap)",
  () => {
    let dir = "";
    let server: Server | null = null;
    afterEach(() => {
      server?.close();
      server = null;
      if (dir !== "") rmSync(dir, { recursive: true, force: true });
    });

    it("refuses the connect with EPERM", async () => {
      dir = mkdtempSync(join(tmpdir(), "atomic-sbx-2469-"));
      const sock = join(dir, "daemon.sock");
      server = createServer((c) => c.end("hello"));
      await new Promise<void>((resolve) => server?.listen(sock, resolve));
      const script =
        "const s=require('net').connect(process.argv[1]);" +
        "s.on('connect',()=>{console.log('connected');s.end()});" +
        "s.on('error',e=>console.log('blocked '+e.code));";
      const w = wrapWithOsSandbox(process.execPath, ["-e", script, sock], policy(false, dir), {
        bwrap: realBwrap,
      });
      if (!w.ok) throw new Error(w.reason);
      const job = startCommandJob(w.command, w.args, {
        cwd: dir,
        ...(w.fd3Input === undefined ? {} : { fd3Input: w.fd3Input }),
      });
      expect(await job.waitFor(20_000)).toBe("exited");
      const out = job.output().stdout;
      expect(out).not.toContain("connected");
      expect(out).toContain("blocked EPERM");
    });
  },
);
