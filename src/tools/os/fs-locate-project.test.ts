import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceClassFor } from "../../agent/tool-resource-class.js";
import {
  getToolDescriptorByName,
  isRareToolName,
} from "../../prompt/tool-descriptors.js";
import { makeCtx, makeTool } from "./fs-locate-project-test-helpers.js";

/** Verdicts (found / ambiguous / miss), fast path, and tool interface. */
describe("os.fs.locate_project", () => {
  let base: string;

  beforeEach(async () => {
    // realpath so expectations survive symlinked tmp dirs
    // (macOS /var -> /private/var) now that candidates are canonicalized.
    base = await realpath(await mkdtemp(join(tmpdir(), "locate-project-")));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("reports ambiguity instead of guessing when two dirs match equally", async () => {
    const rootA = join(base, "root-a");
    const rootB = join(base, "root-b");
    await mkdir(join(rootA, "api"), { recursive: true });
    await mkdir(join(rootB, "api"), { recursive: true });

    const tool = makeTool({ projectRoots: [rootA, rootB] });
    const res = await tool.run({ name: "api" }, makeCtx(base));

    expect(res.status).toBe("ok");
    expect(res.details?.found).toBe(false);
    expect(res.details?.ambiguous).toBe(true);
    expect(res.details?.path).toBeUndefined();
    expect(res.summary).toContain("ambiguous");
    expect(res.summary).toContain("do not guess");
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates.map((c) => c.path).sort()).toEqual([
      join(rootA, "api"),
      join(rootB, "api"),
    ]);
  });

  it("keeps reporting ambiguity even when limit clamps the displayed list", async () => {
    const rootA = join(base, "root-a");
    const rootB = join(base, "root-b");
    await mkdir(join(rootA, "api"), { recursive: true });
    await mkdir(join(rootB, "api"), { recursive: true });

    const tool = makeTool({ projectRoots: [rootA, rootB] });
    const res = await tool.run({ name: "api", limit: 1 }, makeCtx(base));

    expect(res.details?.ambiguous).toBe(true);
    expect(res.details?.found).toBe(false);
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(1);
    expect(res.summary).toContain("1 more");
  });

  it("is honest on a miss and points at projects.roots", async () => {
    const tool = makeTool();
    const res = await tool.run({ name: "does-not-exist" }, makeCtx(base));

    expect(res.status).toBe("ok");
    expect(res.details?.found).toBe(false);
    expect(res.details?.ambiguous).toBe(false);
    expect(res.summary).toContain("no project directory matching");
    expect(res.summary).toContain("Ask the user for the full path");
    expect(res.summary).toContain("projects.roots");
  });

  it("miss with all roots unreadable names the problem in the summary", async () => {
    const tool = makeTool({
      projectRoots: [join(base, "nope-a"), join(base, "nope-b")],
    });
    const res = await tool.run({ name: "anything" }, makeCtx(base));

    expect(res.details?.found).toBe(false);
    expect(res.summary).toContain(
      "none of the 2 configured projects.roots could be scanned",
    );
    expect(res.summary).toContain("2 configured root(s) could not be read");
    expect(res.summary).not.toContain("and 2 configured root(s)");
  });

  it("prefers an exact basename match over substring matches", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "raylib"), { recursive: true });
    await mkdir(join(root, "_raylib"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(join(root, "raylib"));
    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates.map((c) => c.path)).toContain(join(root, "_raylib"));
  });

  it("resolves the issue example: substring match on a short segment", async () => {
    const root = join(base, "drive-e");
    const project = join(root, "_raylib");
    await mkdir(project, { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(project);
  });

  it("fast-path: returns a pasted absolute directory path immediately", async () => {
    const pasted = join(base, "pasted-project");
    await mkdir(pasted, { recursive: true });

    const tool = makeTool();
    const res = await tool.run({ name: pasted }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(pasted);
    expect(res.details?.source).toBe("direct-path");
    expect(res.summary).toContain(pasted);
    expect(res.summary).not.toContain("Ask the user for the full path");
  });

  it("fast-path: a missing absolute path falls through to the honest miss", async () => {
    const tool = makeTool();
    const res = await tool.run(
      { name: join(base, "ghost-project") },
      makeCtx(base),
    );

    expect(res.details?.found).toBe(false);
    expect(res.summary).toContain("no project directory matching");
  });

  it("normalizes backslash input to match by the last segment", async () => {
    const root = join(base, "dev");
    await mkdir(join(root, "_raylib"), { recursive: true });

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "e:\\dev\\_raylib" }, makeCtx(base));

    expect(res.details?.found).toBe(true);
    expect(res.details?.path).toBe(join(root, "_raylib"));
  });

  it("clamps limit and caps the candidate list", async () => {
    const root = join(base, "dev");
    for (let i = 0; i < 6; i++) {
      await mkdir(join(root, `svc-${i}`), { recursive: true });
    }

    const tool = makeTool({ projectRoots: [root] });
    const res = await tool.run({ name: "svc", limit: 3 }, makeCtx(base));

    const candidates = res.details?.candidates as Array<{ path: string }>;
    expect(candidates).toHaveLength(3);
  });

  it("throws on a missing name argument", async () => {
    const tool = makeTool();
    await expect(tool.run({}, makeCtx(base))).rejects.toThrow(
      "`name` must be a non-empty string",
    );
  });

  it("rejects when the context signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const tool = makeTool();
    await expect(
      tool.run({ name: "anything" }, makeCtx(base, controller.signal)),
    ).rejects.toThrow(/abort/i);
  });

  it("descriptor teaches a segment-only name and ships parseable examples", () => {
    const descriptor = getToolDescriptorByName("os.fs.locate_project");
    expect(descriptor).toBeDefined();

    // The blocker case: no quoted multi-word phrase presented as a
    // name value ("my raylib project") anywhere in the summary.
    const summary = descriptor?.summary ?? "";
    expect(summary).not.toMatch(/['"][^'"]*\s[^'"]*['"]/);
    expect(summary).toContain("never the whole sentence");

    const examples = descriptor?.examples ?? [];
    expect(examples.length).toBeGreaterThan(0);
    const schema = descriptor?.argsJsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.required).toContain("name");
    for (const example of examples) {
      const parsed = JSON.parse(example) as Record<string, unknown>;
      // Segment-only: a valid single-token name, never a sentence.
      expect(typeof parsed.name).toBe("string");
      expect(parsed.name as string).not.toContain(" ");
      // Every example key exists in the declared JSON schema.
      for (const key of Object.keys(parsed)) {
        expect(Object.keys(schema.properties)).toContain(key);
      }
    }
  });

  it("is pinned pure_read and frequent-tier", () => {
    expect(resourceClassFor("os.fs.locate_project")).toBe("pure_read");
    expect(isRareToolName("os.fs.locate_project")).toBe(false);
  });
});
