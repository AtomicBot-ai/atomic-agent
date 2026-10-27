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
import { candidateRoots } from "./path-candidate-roots.js";

const everywhere = () => true;
const nowhere = () => false;

describe("missingPathMessage", () => {
  const missing = "/Users/u/Desktop/Atomic Agent/backlinks_demo";
  const found = (paths: string[], complete = true) => ({
    found: paths.map((path) => ({ path, kind: "folder" as const })),
    complete,
  });

  it("offers a candidate as advice, not as an order", () => {
    const text = missingPathMessage(
      "os.fs.read",
      missing,
      found(["/Users/u/Desktop/Atomic Agent/old/backlinks_demo"]),
      everywhere,
    );
    expect(text).toBe(
      `os.fs.read: ${missing} does not exist (ENOENT: no such file or directory). ` +
        'Something named "backlinks_demo" exists elsewhere. ' +
        "If you meant one of these, use it (ask the user if several fit); " +
        "if you were only checking whether it exists, it does not. " +
        "A folder is listed with os.fs.list, not read.\n" +
        "- /Users/u/Desktop/Atomic Agent/old/backlinks_demo (folder)",
    );
  });

  // ATO-413: the real folder was outside the working folder.
  it("marks a candidate outside the working folder and says reading it will ask", () => {
    const text = missingPathMessage(
      "os.fs.list",
      missing,
      found(["/Users/u/Desktop/backlinks_demo"]),
      nowhere,
    );
    expect(text).toContain(
      "/Users/u/Desktop/backlinks_demo (folder, outside the working folder; reading it will ask the user for permission)",
    );
    expect(text).not.toContain("os.fs.list, not read");
  });

  it("shows at most five, and the advice comes before the list", () => {
    const text = missingPathMessage(
      "os.fs.list",
      missing,
      found(Array.from({ length: 6 }, (_, i) => `/p${i}/backlinks_demo`)),
      everywhere,
    );
    expect(text).toContain("- /p4/backlinks_demo (folder)");
    expect(text).not.toContain("/p5/");
    expect(text).toContain("- … and more");
    expect(text.indexOf("ask the user")).toBeLessThan(text.indexOf("/p0/"));
  });

  it("with nothing found, says so and not to retry; a cut search says it was quick", () => {
    const none = missingPathMessage("os.fs.read", missing, found([]), everywhere);
    expect(none).toContain('Nothing named "backlinks_demo" was found nearby.');
    expect(none).toContain("Do not retry the same path.");
    const cut = missingPathMessage("os.fs.read", missing, found([], false), everywhere);
    expect(cut).toContain('A quick search found nothing named "backlinks_demo".');
  });

  it("names ENOTDIR, and tells a worker not to search elsewhere", () => {
    const notDir = missingPathMessage("os.fs.read", missing, found([]), everywhere, {
      code: "ENOTDIR",
    });
    expect(notDir).toContain("(ENOTDIR: a part of the path is a file, not a folder)");
    const worker = missingPathMessage("os.fs.read", missing, found([]), everywhere, {
      worker: true,
    });
    expect(worker).toContain("Do not search elsewhere; name it as missing in your reply.");
  });
});

describe("candidateRoots", () => {
  const home = "/Users/u";
  const exists = async (path: string) =>
    ["/Users/u/work", "/Users/u/work/projects", "/Users/u"].includes(path);

  it("searches the working folder and the nearest existing ancestor, never home itself", async () => {
    const plan = await candidateRoots({
      missing: "/Users/u/work/projects/gone/backlinks_demo",
      workingDir: "/Users/u/work",
      home,
      platform: "darwin",
      exists,
    });
    const dirs = plan.roots.map((r) => r.dir);
    expect(dirs).toContain("/Users/u/work");
    expect(dirs).toContain("/Users/u/work/projects");
    expect(dirs).not.toContain(home);
    expect(dirs).not.toContain("/");
  });

  it("blocks Desktop, Documents and Downloads the session has not touched", async () => {
    const plan = await candidateRoots({
      missing: "/Users/u/work/backlinks_demo",
      workingDir: "/Users/u/work",
      home,
      platform: "darwin",
      exists,
    });
    expect(plan.blocked).toEqual(
      expect.arrayContaining(["/Users/u/Desktop", "/Users/u/Documents", "/Users/u/Pictures"]),
    );
    expect(plan.roots.map((r) => r.dir)).not.toContain("/Users/u/Desktop");
  });

  it("searches a protected folder the missing path is already inside", async () => {
    const plan = await candidateRoots({
      missing: "/Users/u/Desktop/Atomic Agent/backlinks_demo",
      workingDir: "/Users/u/work",
      home,
      platform: "darwin",
      exists,
    });
    expect(plan.blocked).not.toContain("/Users/u/Desktop");
    expect(plan.roots).toContainEqual({ dir: "/Users/u/Desktop", depth: 3 });
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
    // A missing path inside a temp folder: the search lists the working
    // folder and a level or two above it, never the real home folder.
    ctx = {
      workingDir: work,
      sessionId: "s-missing-path",
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
      `- ${join(work, "projects", "backlinks_demo")} (folder)`,
    );
    expect(result.summary).toContain("A folder is listed with os.fs.list, not read.");
    expect(result.details).toMatchObject({
      path: join(work, "backlinks_demo"),
      errorCode: "ENOENT",
      candidates: [join(work, "projects", "backlinks_demo")],
    });
  });

  it("os.fs.list, os.fs.hash and os.fs.glob give the same answer", async () => {
    const list = await osFsListTool.run({ path: "backlinks_demo" }, ctx);
    expect(list.status).toBe("error");
    expect(list.summary).toContain(join(work, "projects", "backlinks_demo"));

    const hash = await osFsHashTool.run({ path: "notes.txt" }, ctx);
    expect(hash.status).toBe("error");
    expect(hash.summary).toContain(`- ${join(work, "projects", "notes.txt")} (file)`);
    expect(hash.summary).not.toContain("secret body");

    const glob = await buildOsFsGlobTool().run(
      { pattern: "*.txt", cwd: "backlinks_demo" },
      ctx,
    );
    expect(glob.status).toBe("error");
    expect(glob.summary).toContain(join(work, "projects", "backlinks_demo"));
  });

  it("a fusion worker is told the path is missing, not where else to look", async () => {
    const result = await osFsReadTool.run(
      { path: "backlinks_demo" },
      { ...ctx, sessionId: `${FUSION_WORKER_ID_PREFIX}missing-path` },
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Do not search elsewhere");
    expect(result.summary).not.toContain(join(work, "projects"));
  });

  it("a read of a real file is unchanged", async () => {
    const result = await osFsReadTool.run({ path: "projects/notes.txt" }, ctx);
    expect(result.status).toBe("ok");
  });

  it("searches the given plan, and keeps a long list whole", async () => {
    const roots = [];
    for (const dir of ["a", "b", "c", "d", "e", "f"]) {
      const parent = join(base, "far", `${dir}-${"x".repeat(60)}`);
      await mkdir(join(parent, "report"), { recursive: true });
      roots.push({ dir: parent, depth: 1 });
    }
    const result = await missingPathResult(
      "os.fs.read",
      join(work, "report"),
      ctx,
      "ENOENT",
      { roots, blocked: [] },
    );
    expect(result.summary).toContain("ask the user if several fit");
    expect(result.summary).toContain("- … and more");
    expect(result.summary).not.toContain("[truncated]");
  });
});
