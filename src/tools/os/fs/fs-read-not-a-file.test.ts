import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../../tool-registry.js";
import { osFsReadTool } from "./fs-read.js";

describe("os.fs.read on a path that is not a regular file", () => {
  let workingDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "atomic-fs-read-not-a-file-"));
    ctx = {
      workingDir,
      sessionId: "not-a-file",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("a directory points at os.fs.list", async () => {
    await mkdir(join(workingDir, "notes"));
    await expect(osFsReadTool.run({ path: "notes" }, ctx)).rejects.toThrow(
      /is not a regular file — it is a directory\. List it with os\.fs\.list/,
    );
  });

  // ATO-308: a local Fusion planner used /dev/null as a placeholder path
  // and re-sent the read after every bare "is not a regular file".
  it.skipIf(process.platform === "win32")(
    "/dev/null says there is nothing to read and not to use it as a placeholder",
    async () => {
      await expect(osFsReadTool.run({ path: "/dev/null" }, ctx)).rejects.toThrow(
        /\/dev\/null is not a regular file — it is a device, so there is nothing to read\. Do not use it as a placeholder/,
      );
    },
  );
});
