import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DiagnosticsClient } from "./lsp-client.js";
import type { PublishedDiagnostics } from "./lsp-published.js";
import { createLspServerPool, type LspServerPool } from "./lsp-server-pool.js";
import { collectWorkspaceProblems } from "./lsp-workspace-problems.js";

let repo: string;

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "lsp-problems-")));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "bad.ts"), "BROKEN\n");
  writeFileSync(join(repo, "src", "ok.ts"), "fine\n");
  writeFileSync(join(repo, "notes.md"), "# not code\n");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

class FakeClient implements DiagnosticsClient {
  alive = true;
  seen: string[] = [];
  constructor(private readonly publishedFiles: PublishedDiagnostics[] = []) {}
  async diagnose(path: string, _languageId: string, text: string) {
    this.seen.push(path);
    return text.includes("BROKEN") ? [{ message: "Cannot find name 'BROKEN'.", severity: 1, range: { start: { line: 0, character: 0 } } }] : [];
  }
  published() {
    return this.publishedFiles;
  }
  dispose(): void {
    this.alive = false;
  }
}

function pool(client: FakeClient, options: { installed?: boolean; trusted?: boolean } = {}): LspServerPool {
  return createLspServerPool({
    findBinary: (command) => (options.installed === false ? null : `/opt/bin/${command}`),
    findRoot: (dir) => (dir.startsWith(repo) ? repo : null),
    startClient: async () => client,
    isTrustedProject: () => options.trusted ?? true,
    askToStart: async () => "yes",
  });
}

describe("collectWorkspaceProblems (ATO-2472)", () => {
  it("is off without a pool", async () => {
    expect(await collectWorkspaceProblems({ pool: null, workingDir: repo, changedFiles: async () => [] })).toEqual({ state: "off" });
  });

  it("checks the changed code files and reports their problems, relative to the folder", async () => {
    const client = new FakeClient();
    const result = await collectWorkspaceProblems({
      pool: pool(client),
      workingDir: repo,
      changedFiles: async () => ["src/bad.ts", "src/ok.ts", "notes.md", "../escape.ts"],
    });
    expect(result).toEqual({
      state: "ok",
      servers: ["typescript"],
      files: [{ path: "src/bad.ts", diagnostics: [expect.objectContaining({ message: "Cannot find name 'BROKEN'." })] }],
    });
    expect(client.seen.sort()).toEqual([join(repo, "src", "bad.ts"), join(repo, "src", "ok.ts")]);
  });

  it("says no server when none is installed", async () => {
    const result = await collectWorkspaceProblems({
      pool: pool(new FakeClient(), { installed: false }),
      workingDir: repo,
      changedFiles: async () => ["src/bad.ts"],
    });
    expect(result).toEqual({ state: "no_server" });
  });

  it("never asks to start a server in an untrusted folder", async () => {
    let asked = false;
    const p = createLspServerPool({
      findBinary: (command) => `/opt/bin/${command}`,
      findRoot: () => repo,
      startClient: async () => new FakeClient(),
      isTrustedProject: () => false,
      askToStart: async () => { asked = true; return "yes"; },
    });
    const result = await collectWorkspaceProblems({ pool: p, workingDir: repo, changedFiles: async () => ["src/bad.ts"] });
    expect(asked).toBe(false);
    expect(result).toEqual({ state: "no_server" });
  });

  it("adds what running servers published inside the folder, and nothing outside it", async () => {
    const client = new FakeClient([
      { path: join(repo, "src", "old.ts"), diagnostics: [{ message: "old error", severity: 1 }] },
      { path: join(tmpdir(), "elsewhere.ts"), diagnostics: [{ message: "not ours", severity: 1 }] },
    ]);
    const p = pool(client);
    // A first use starts the server; the second collection reads its publishes.
    await collectWorkspaceProblems({ pool: p, workingDir: repo, changedFiles: async () => ["src/ok.ts"] });
    const result = await collectWorkspaceProblems({ pool: p, workingDir: repo, changedFiles: async () => [] });
    expect(result.state).toBe("ok");
    if (result.state !== "ok") return;
    expect(result.files.map((f) => f.path)).toEqual(["src/old.ts"]);
  });

  it("stops waiting at the budget", async () => {
    const slow = createLspServerPool({
      findBinary: (command) => `/opt/bin/${command}`,
      findRoot: () => repo,
      startClient: () => new Promise(() => {}),
    });
    const started = Date.now();
    await collectWorkspaceProblems({ pool: slow, workingDir: repo, changedFiles: async () => ["src/bad.ts"], budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
