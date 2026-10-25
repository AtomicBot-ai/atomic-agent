import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FUSION_WORKER_ID_PREFIX } from "../../../session/fusion-worker-session.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsGlobTool } from "./fs-glob.js";
import { osFsHashTool } from "./fs-hash.js";
import { osFsListTool } from "./fs-list.js";
import { missingPathMessage, missingPathResult } from "./fs-missing-path.js";
import { osFsReadTool } from "./fs-read.js";
import { defaultCandidateRoots } from "./path-candidates.js";

const everywhere = () => true;
const nowhere = () => false;

describe("missingPathMessage", () => {
  const missing = "/Users/u/Desktop/Atomic Agent/backlinks_demo";

  it("names one candidate in the working folder and the next move", () => {
    const text = missingPathMessage(
      "os.fs.read",
      missing,
      [{ path: "/Users/u/Desktop/Atomic Agent/old/backlinks_demo", kind: "folder" }],
      everywhere,
    );
    expect(text).toBe(
      `os.fs.read: ${missing} does not exist (ENOENT: no such file or directory). ` +
        'Found "backlinks_demo" at /Users/u/Desktop/Atomic Agent/old/backlinks_demo (folder). ' +
        "Use that path with os.fs.list.",
    );
  });

  // ATO-413: the real folder was outside the working folder.
  it("marks a candidate outside the working folder and says how to reach it", () => {
    const text = missingPathMessage(
      "os.fs.read",
      missing,
      [{ path: "/Users/u/Desktop/backlinks_demo", kind: "folder" }],
      nowhere,
    );
    expect(text).toContain(
      "/Users/u/Desktop/backlinks_demo (folder, outside the working folder)",
    );
    expect(text).toContain("ask the user to open that folder as the working folder");
    expect(text).not.toContain("Use that path");
  });

  it("asks the user to choose among several, at most five shown", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      path: `/p${i}/backlinks_demo`,
      kind: "folder" as const,
    }));
    const text = missingPathMessage("os.fs.list", missing, candidates, everywhere);
    expect(text).toContain("Ask the user which one they mean; do not guess.");
    expect(text).toContain("- /p4/backlinks_demo (folder)");
    expect(text).not.toContain("/p5/");
    expect(text).toContain("- … and more");
    // The instruction comes before the list, so a clipped result keeps it.
    expect(text.indexOf("do not guess")).toBeLessThan(text.indexOf("/p0/"));
  });

  it("with nothing found, asks where it is instead of retrying", () => {
    const text = missingPathMessage("os.fs.read", missing, [], everywhere);
    expect(text).toContain('Nothing named "backlinks_demo" was found');
    expect(text).toContain("do not retry the same path");
  });
});

describe("read-class tools on a missing path", () => {
  let base: string;
  let work: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atomic-fs-missing-"));
    work = join(base, "work");
    await mkdir(join(work, "projects", "backlinks_demo"), { recursive: true });
    await writeFile(join(work, "projects", "notes.txt"), "secret body");
    // A worker session searches only its working folder, so these tests
    // never look at the real home folder.
    ctx = {
      workingDir: work,
      sessionId: `${FUSION_WORKER_ID_PREFIX}missing-path`,
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("os.fs.read answers with where the folder is, the code and the path", async () => {
    const result = await osFsReadTool.run({ path: "backlinks_demo" }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain(
      `${join(work, "backlinks_demo")} does not exist (ENOENT`,
    );
    expect(result.summary).toContain(
      `Found "backlinks_demo" at ${join(work, "projects", "backlinks_demo")} (folder). Use that path with os.fs.list.`,
    );
    expect(result.details).toMatchObject({
      path: join(work, "backlinks_demo"),
      errorCode: "ENOENT",
    });
  });

  it("os.fs.list, os.fs.hash and os.fs.glob give the same answer", async () => {
    const list = await osFsListTool.run({ path: "backlinks_demo" }, ctx);
    expect(list.status).toBe("error");
    expect(list.summary).toContain(join(work, "projects", "backlinks_demo"));

    const hash = await osFsHashTool.run({ path: "notes.txt" }, ctx);
    expect(hash.status).toBe("error");
    expect(hash.summary).toContain(
      `${join(work, "projects", "notes.txt")} (file). Use that path.`,
    );
    expect(hash.summary).not.toContain("secret body");

    const glob = await buildOsFsGlobTool().run(
      { pattern: "*.txt", cwd: "backlinks_demo" },
      ctx,
    );
    expect(glob.status).toBe("error");
    expect(glob.summary).toContain(join(work, "projects", "backlinks_demo"));
  });

  it("a read of a real file is unchanged", async () => {
    const result = await osFsReadTool.run({ path: "projects/notes.txt" }, ctx);
    expect(result.status).toBe("ok");
  });

  it("searches injected roots, and keeps a long list whole", async () => {
    const home = join(base, "home");
    for (const dir of ["a", "b", "c", "d", "e", "f"]) {
      await mkdir(join(home, "Desktop", `${dir}-${"x".repeat(60)}`, "report"), {
        recursive: true,
      });
    }
    const result = await missingPathResult(
      "os.fs.read",
      join(work, "report"),
      { ...ctx, sessionId: "s-session" },
      defaultCandidateRoots(work, home),
    );
    expect(result.summary).toContain("Ask the user which one they mean");
    expect(result.summary).toContain("- … and more");
    expect(result.summary).not.toContain("[truncated]");
  });
});
