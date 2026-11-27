import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticsClient } from "../fs/lsp/lsp-client.js";
import { createLspServerPool } from "../fs/lsp/lsp-server-pool.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsCodeLspTool } from "./code-lsp.js";
import { formatLspAnswer } from "./code-lsp-format.js";

/** A server that answers every request from a table and records it. */
class NavClient implements DiagnosticsClient {
  alive = true;
  readonly synced: string[] = [];
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  constructor(private readonly answer: (method: string) => unknown) {}
  async diagnose() {
    return [];
  }
  sync(_path: string, _languageId: string, text: string): void {
    this.synced.push(text);
  }
  async request<T = unknown>(method: string, params: unknown): Promise<T> {
    this.requests.push({ method, params: params as Record<string, unknown> });
    return this.answer(method) as T;
  }
  dispose(): void {}
}

let repo: string;
let outside: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "atomic-lsp-nav-"));
  outside = await mkdtemp(join(tmpdir(), "atomic-lsp-out-"));
  await mkdir(join(repo, ".git"));
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src", "a.ts"), "import { helper } from './b';\nconst value = helper();\n");
  await writeFile(join(repo, "src", "b.ts"), "// helpers\nexport function helper() {\n  return 1;\n}\n");
  await writeFile(join(outside, "lib.d.ts"), "line one\nline two\ndeclare const secret: string;\n");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function setup(answer: (method: string) => unknown, onPath = true) {
  const client = new NavClient(answer);
  const starts: string[] = [];
  const pool = createLspServerPool({
    findBinary: (command) => (onPath ? `/opt/bin/${command}` : null),
    findRoot: (dir) => (dir.startsWith(repo) ? repo : null),
    startClient: async (spec) => {
      starts.push(spec.command);
      return client;
    },
  });
  const tool = buildOsCodeLspTool({ pool, startupWaitMs: 1000, requestTimeoutMs: 1000 });
  const ctx: ToolContext = { workingDir: repo, sessionId: "s1", stepIndex: 0, signal: new AbortController().signal };
  return { client, starts, tool, ctx };
}

const location = (file: string, line: number, character: number) => ({
  uri: pathToFileURL(file).href,
  range: { start: { line, character }, end: { line, character: character + 6 } },
});

describe("os.code.lsp (ATO-2373)", () => {
  it("finds a definition: one path:line:col line with the code there", async () => {
    const { client, starts, tool, ctx } = setup(() => [location(join(repo, "src", "b.ts"), 1, 16)]);
    const result = await tool.run({ action: "definition", path: "src/a.ts", line: 2, query: "helper" }, ctx);
    expect(result.status).toBe("ok");
    expect(starts).toEqual(["typescript-language-server"]);
    // `query` put the cursor on `helper` (column 15, 0-based 14).
    expect(client.requests[0]).toMatchObject({
      method: "textDocument/definition",
      params: { position: { line: 1, character: 14 } },
    });
    expect(client.synced[0]).toContain("const value = helper();");
    expect(result.summary).toContain("1 definition of src/a.ts:2:15");
    expect(result.summary).toContain("src/b.ts:2:17: export function helper() {");
  });

  it("caps references and says how many were left out", async () => {
    const hits = Array.from({ length: 60 }, (_, i) => location(join(repo, "src", "b.ts"), i % 3, i));
    const { tool, ctx } = setup(() => hits);
    const result = await tool.run({ action: "references", path: "src/a.ts", line: 1, col: 10, maxResults: 5 }, ctx);
    expect(result.summary).toContain("60 references to src/a.ts:1:10 in 1 file (first 5 shown; raise maxResults to see more)");
    expect(result.summary.split("\n").filter((l) => l.startsWith("src/b.ts:"))).toHaveLength(5);
    expect(result.details).toMatchObject({ total: 60, shown: 5 });
  });

  it("shows a hit outside the read scope without its code", async () => {
    const { tool, ctx } = setup(() => [location(join(outside, "lib.d.ts"), 2, 0)]);
    const result = await tool.run({ action: "definition", path: "src/a.ts", line: 1, col: 10 }, ctx);
    expect(result.summary).toContain(`${join(outside, "lib.d.ts")}:3:1`);
    expect(result.summary).not.toContain("secret");
  });

  it("lists symbols of the file with kind and name", async () => {
    const { client, tool, ctx } = setup(() => [
      { name: "helper", kind: 12, range: { start: { line: 1, character: 0 } }, selectionRange: { start: { line: 1, character: 16 } } },
    ]);
    const result = await tool.run({ action: "symbols", path: "src/b.ts" }, ctx);
    expect(client.requests[0]!.method).toBe("textDocument/documentSymbol");
    expect(result.summary).toContain("1 symbol in src/b.ts");
    expect(result.summary).toContain("src/b.ts:2: function helper");
  });

  it("answers a missing server with an error that says nothing is installed", async () => {
    const { starts, tool, ctx } = setup(() => null, false);
    const result = await tool.run({ action: "hover", path: "src/a.ts", line: 1, col: 1 }, ctx);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("`typescript-language-server` is not on PATH");
    expect(starts).toEqual([]);
  });

  it("refuses a position action without a line, and a query that is not on the line", async () => {
    const { tool, ctx } = setup(() => null);
    await expect(tool.run({ action: "definition", path: "src/a.ts" }, ctx)).rejects.toThrow(/needs `line`/);
    await expect(tool.run({ action: "definition", path: "src/a.ts", line: 1, query: "nowhere" }, ctx)).rejects.toThrow(
      /not on line 1/,
    );
    await expect(tool.run({ action: "rename", path: "src/a.ts", line: 1 }, ctx)).rejects.toThrow(/`action` must be one of/);
  });
});

describe("formatLspAnswer (ATO-2373)", () => {
  const base = {
    target: "src/a.ts:3:5",
    maxResults: 2,
    displayPath: (p: string) => p.replace("/r/", ""),
    lineOf: (_p: string, line: number) => (line === 7 ? `    ${"x".repeat(300)}` : `code at ${line}`),
  };

  it("prints one line per hit, drops duplicates, clips long lines", () => {
    const hits = [
      { path: "/r/b.ts", uri: "file:///r/b.ts", line: 7, col: 1 },
      { path: "/r/b.ts", uri: "file:///r/b.ts", line: 7, col: 1 },
      { path: "/r/c.ts", uri: "file:///r/c.ts", line: 2, col: 4 },
    ];
    const out = formatLspAnswer({ kind: "hits", hits }, { ...base, action: "references" });
    const lines = out.text.split("\n");
    expect(lines[0]).toBe("2 references to src/a.ts:3:5 in 2 files");
    expect(lines[1]).toBe(`b.ts:7:1: ${"x".repeat(197)}...`);
    expect(lines[2]).toBe("c.ts:2:4: code at 2");
    expect(out).toMatchObject({ total: 2, shown: 2 });
  });

  it("says nothing was found, with the indexing hint", () => {
    const out = formatLspAnswer({ kind: "hits", hits: [] }, { ...base, action: "definition" });
    expect(out.text).toMatch(/^no definition found for src\/a\.ts:3:5\.\n.*indexing/);
  });

  it("cuts a long hover", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const out = formatLspAnswer({ kind: "hover", text }, { ...base, action: "hover" });
    expect(out.text.startsWith("hover at src/a.ts:3:5:\nline 0")).toBe(true);
    expect(out.text).toContain("line 39");
    expect(out.text).not.toContain("line 40");
    expect(out.text.endsWith("... (cut)")).toBe(true);
  });
});
