import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../../tool-registry.js";
import { OutlineCache } from "./code-map-cache.js";
import { buildOsFsCodeMapTool, codeMapBudget, focusFileKeys, parseCodeMapArgs, splitFocus } from "./code-map-tool.js";
import type { OutlineBackend } from "./outline-types.js";
import { regexOutlineBackend } from "./regex-outline.js";

function ctx(workingDir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { workingDir, sessionId: "s", stepIndex: 0, signal: new AbortController().signal, ...extra };
}

/** Counts parses so the cache can be observed. */
function countingBackend(): OutlineBackend & { calls: number } {
  const backend = {
    id: "counting",
    calls: 0,
    supports: () => true,
    outline(source: string, language: Parameters<OutlineBackend["outline"]>[1]) {
      backend.calls++;
      return regexOutlineBackend.outline(source, language);
    },
  };
  return backend;
}

describe("os.fs.code_map", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-code-map-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await mkdir(join(dir, ".hidden"));
    await writeFile(join(dir, "src", "core.ts"), "export class ConfigLoader {\n  load() {}\n}\n");
    await writeFile(join(dir, "src", "app.ts"), "import { ConfigLoader } from './core';\nexport function startApp() { new ConfigLoader().load(); }\n");
    await writeFile(join(dir, "src", "util.py"), "def helper_function():\n    pass\n");
    await writeFile(join(dir, "README.md"), "# not code\n");
    await writeFile(join(dir, "node_modules", "dep", "index.js"), "export function ignoredDep() {}\n");
    await writeFile(join(dir, ".hidden", "secret.ts"), "export const hiddenThing = 1;\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps the working directory, most-referenced file first, skipping ignored and dot folders", async () => {
    const tool = buildOsFsCodeMapTool({ cache: new OutlineCache(), backend: async () => regexOutlineBackend });
    const result = await tool.run({}, ctx(dir));
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("src/core.ts");
    expect(result.summary.indexOf("src/core.ts")).toBeLessThan(result.summary.indexOf("src/app.ts"));
    expect(result.summary).toContain("L1 export class ConfigLoader");
    expect(result.summary).toContain("src/util.py");
    expect(result.summary).not.toContain("ignoredDep");
    expect(result.summary).not.toContain("hiddenThing");
    expect(result.summary).not.toContain("README");
    expect(result.details).toMatchObject({ mode: "project", filesOutlined: 3, backend: "regex" });
  });

  it("outlines one file when path is a file", async () => {
    const tool = buildOsFsCodeMapTool({ cache: new OutlineCache(), backend: async () => regexOutlineBackend });
    const result = await tool.run({ path: "src/core.ts" }, ctx(dir));
    expect(result.summary).toContain("src/core.ts (4 lines, 2 symbols)");
    expect(result.summary).toContain("    L2 load()");
    expect(result.details).toMatchObject({ mode: "file", symbols: 2 });
  });

  it("refuses a non-source file and answers a missing path with the missing-path result", async () => {
    const tool = buildOsFsCodeMapTool({ cache: new OutlineCache(), backend: async () => regexOutlineBackend });
    await expect(tool.run({ path: "README.md" }, ctx(dir))).rejects.toThrow("not a source file");
    const missing = await tool.run({ path: "nope" }, ctx(dir));
    expect(missing.status).not.toBe("ok");
  });

  it("re-parses only files whose mtime or size changed", async () => {
    const backend = countingBackend();
    const tool = buildOsFsCodeMapTool({ cache: new OutlineCache(), backend: async () => backend });
    await tool.run({}, ctx(dir));
    expect(backend.calls).toBe(3);
    await tool.run({}, ctx(dir));
    expect(backend.calls).toBe(3);
    const later = new Date(Date.now() + 5_000);
    await writeFile(join(dir, "src", "app.ts"), "export function startApp2() {}\n");
    await utimes(join(dir, "src", "app.ts"), later, later);
    await tool.run({}, ctx(dir));
    expect(backend.calls).toBe(4);
  });

  it("stops a walk on the budget and says the map is partial", async () => {
    let t = 0;
    const tool = buildOsFsCodeMapTool({
      cache: new OutlineCache(),
      backend: async () => regexOutlineBackend,
      budget: { maxMs: 1, maxEntries: 1_000_000 },
      now: () => (t += 10),
    });
    const result = await tool.run({}, ctx(dir));
    expect(result.summary).toContain("[partial results");
    expect(result.details).toMatchObject({ truncated: true, stoppedBy: "time" });
  });
});

describe("code map arguments", () => {
  it("validates types", () => {
    expect(() => parseCodeMapArgs({ path: "" })).toThrow("path");
    expect(() => parseCodeMapArgs({ maxTokens: "a" })).toThrow("maxTokens");
    expect(() => parseCodeMapArgs({ focus: "x" })).toThrow("focus");
    expect(parseCodeMapArgs({ path: " src ", focus: ["a", " "] })).toEqual({ path: "src", maxTokens: undefined, focus: ["a"] });
  });

  it("sizes the budget from the request, else the window, clamped", () => {
    expect(codeMapBudget(50, undefined)).toBe(200);
    expect(codeMapBudget(99_999, undefined)).toBe(8_000);
    expect(codeMapBudget(undefined, 32_768)).toBe(983);
    expect(codeMapBudget(undefined, 131_072)).toBe(3_932);
    expect(codeMapBudget(undefined, undefined)).toBe(1_500);
  });

  it("tells focus files from focus names", () => {
    expect(splitFocus(["src/a.ts", "./b.py", "core.go", "AgentLoop", "parse_config"])).toEqual({
      files: ["src/a.ts", "b.py", "core.go"],
      idents: ["AgentLoop", "parse_config"],
    });
  });

  it("matches a focus path given from the working dir or from the map root", () => {
    const work = join(tmpdir(), "proj");
    const root = join(work, "src", "agent");
    const keys = focusFileKeys(["src/agent/loop.ts", "loop.ts", "other/x.ts", join(root, "abs.ts")], work, root);
    // working-dir relative, resolved into the map root
    expect(keys.has("loop.ts")).toBe(true);
    // map-root relative, kept as given
    expect(keys.has("src/agent/loop.ts")).toBe(true);
    // absolute, made relative to the map root
    expect(keys.has("abs.ts")).toBe(true);
    // outside the map root: only the literal form, no `../` key
    expect([...keys].some((k) => k.startsWith("../"))).toBe(false);
  });
});

describe("OutlineCache", () => {
  it("drops the oldest entry past its bound and misses on a changed mtime", () => {
    const cache = new OutlineCache(2);
    const outline = { language: "typescript" as const, symbols: [], mentions: new Map(), lineCount: 1 };
    cache.set("r", "/a", 1, 1, outline);
    cache.set("r", "/b", 1, 1, outline);
    cache.set("r", "/c", 1, 1, outline);
    expect(cache.size).toBe(2);
    expect(cache.get("r", "/a", 1, 1)).toBeUndefined();
    expect(cache.get("r", "/b", 2, 1)).toBeUndefined();
    expect(cache.get("r", "/c", 1, 1)).toBe(outline);
  });
});
