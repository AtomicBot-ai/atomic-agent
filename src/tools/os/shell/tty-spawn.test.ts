import { describe, expect, it } from "vitest";

import type { NodePtyModule, NodePtySpawnOptions } from "../../../native/load-node-pty.js";
import { startInteractiveJob } from "./tty-spawn.js";

function recordingPty() {
  const spawned: Array<{ file: string; args: string[] | string; options: NodePtySpawnOptions }> = [];
  const module: NodePtyModule = {
    spawn(file, args, options) {
      spawned.push({ file, args, options });
      return {
        pid: 7,
        cols: 0,
        rows: 0,
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      };
    },
  };
  return { module, spawned };
}

/** ATO-2484: node-pty first, then script(1), then pipes. */
describe("startInteractiveJob", () => {
  it("runs on node-pty when the binding loads, on every platform", () => {
    const pty = recordingPty();
    const started = startInteractiveJob(
      { command: "cmd.exe", args: ["/d", "/s", "/c", "python"], windowsVerbatimArguments: true },
      { cwd: "C:\\w", env: { TERM: "dumb" } },
      { loadPty: () => pty.module, platform: "win32" },
    );
    expect(started.backend).toBe("pty");
    expect(pty.spawned).toHaveLength(1);
    // the program itself, not wrapped in script(1)
    expect(pty.spawned[0]!.file).toBe("cmd.exe");
    expect(pty.spawned[0]!.args).toBe("/d /s /c python");
    expect("resize" in started.job).toBe(true);
  });

  it("without the binding, Windows falls back to plain pipes", () => {
    const started = startInteractiveJob(
      // `node -e` keeps the spawn harmless on any host the test runs on.
      { command: process.execPath, args: ["-e", ""] },
      { cwd: process.cwd(), env: process.env },
      { loadPty: () => null, platform: "win32", exists: () => true },
    );
    expect(started.backend).toBe("pipes");
    started.job.kill();
  });

  it("a pty that cannot start the program falls back instead of failing", () => {
    const refusing: NodePtyModule = {
      spawn: () => {
        throw new Error("File not found: python");
      },
    };
    const started = startInteractiveJob(
      { command: process.execPath, args: ["-e", ""] },
      { cwd: process.cwd(), env: process.env },
      { loadPty: () => refusing, platform: "win32" },
    );
    expect(started.backend).toBe("pipes");
    started.job.kill();
  });

  it("without the binding, Linux with script(1) uses script", () => {
    const started = startInteractiveJob(
      { command: process.execPath, args: ["-e", ""] },
      { cwd: process.cwd(), env: process.env },
      // `exists: () => false` would mean no script; here it is "there",
      // but the spawn of /usr/bin/script may fail on a host without it,
      // which only rejects the job's first wait.
      { loadPty: () => null, platform: "linux", exists: () => true },
    );
    expect(started.backend).toBe("script");
    started.job.waitFor(1).catch(() => undefined);
    started.job.kill();
  });
});
