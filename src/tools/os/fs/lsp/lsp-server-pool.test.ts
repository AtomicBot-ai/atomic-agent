import { describe, expect, it } from "vitest";
import type { DiagnosticsClient } from "./lsp-client.js";
import { createLspDiagnostics } from "./lsp-diagnostics.js";
import { createLspServerPool, type StartClient } from "./lsp-server-pool.js";

class FakeClient implements DiagnosticsClient {
  alive = true;
  async diagnose(_path: string, _languageId: string, text: string) {
    return text.includes("BROKEN") ? [{ message: "undefined: x", severity: 1 }] : [];
  }
  dispose(): void {
    this.alive = false;
  }
}

const REPO = "/work/repo";

function setup(onPath: ReadonlySet<string>) {
  const starts: Array<{ id: string; binary: string; root: string }> = [];
  const lookups: string[] = [];
  const startClient: StartClient = async (spec, binary, root) => {
    starts.push({ id: spec.id, binary, root });
    return new FakeClient();
  };
  const pool = createLspServerPool({
    // The injected PATH lookup: only the named commands are "installed".
    findBinary: (command) => {
      lookups.push(command);
      return onPath.has(command) ? `/opt/bin/${command}` : null;
    },
    findRoot: (dir) => (dir.startsWith(REPO) ? REPO : null),
    startClient,
  });
  return { pool, starts, lookups };
}

const job = async () => "ran";

describe("createLspServerPool (ATO-2373)", () => {
  it("uses a new language's server only when its binary is on PATH, and never installs it", async () => {
    const missing = setup(new Set());
    await expect(missing.pool.withServer(`${REPO}/main.go`, {}, 1000, job)).resolves.toMatchObject({
      ok: false,
      reason: "not_installed",
    });
    expect(missing.starts).toEqual([]);
    expect(missing.lookups).toEqual(["gopls"]);

    const present = setup(new Set(["gopls", "rust-analyzer"]));
    await expect(present.pool.withServer(`${REPO}/main.go`, {}, 1000, job)).resolves.toEqual({ ok: true, value: "ran" });
    await expect(present.pool.withServer(`${REPO}/src/lib.rs`, {}, 1000, job)).resolves.toEqual({ ok: true, value: "ran" });
    expect(present.starts).toEqual([
      { id: "gopls", binary: "/opt/bin/gopls", root: REPO },
      { id: "rust-analyzer", binary: "/opt/bin/rust-analyzer", root: REPO },
    ]);
  });

  it("says why nothing ran: unknown language, outside a repository", async () => {
    const { pool, starts } = setup(new Set(["gopls"]));
    await expect(pool.withServer(`${REPO}/notes.md`, {}, 1000, job)).resolves.toMatchObject({ reason: "no_language" });
    await expect(pool.withServer("/tmp/loose/main.go", {}, 1000, job)).resolves.toMatchObject({ reason: "no_project" });
    expect(starts).toEqual([]);
  });

  it("is declined when the operator says no in an untrusted work tree", async () => {
    const pool = createLspServerPool({
      findBinary: (command) => `/opt/bin/${command}`,
      findRoot: () => REPO,
      startClient: async () => new FakeClient(),
      askToStart: async () => "no",
    });
    await expect(pool.withServer(`${REPO}/a.ts`, { sessionId: "s1" }, 1000, job)).resolves.toMatchObject({
      reason: "declined",
    });
  });

  it("serves the diagnostics and navigation from one server per language per repository", async () => {
    const { pool, starts } = setup(new Set(["gopls"]));
    const lsp = createLspDiagnostics({ enabled: true, pool });
    // The diagnostics path reads the same table: a Go edit gets gopls errors.
    const warning = await lsp.diagnoseChange({
      absolute: `${REPO}/main.go`,
      display: "main.go",
      change: "edit",
      before: "package main\n",
      after: "package main\nBROKEN\n",
    });
    expect(warning).toContain("1 new error from gopls");
    await expect(pool.withServer(`${REPO}/main.go`, {}, 1000, job)).resolves.toEqual({ ok: true, value: "ran" });
    expect(starts).toHaveLength(1);
  });

  it("runs jobs on one server one at a time", async () => {
    const { pool } = setup(new Set(["gopls"]));
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = pool.withServer(`${REPO}/a.go`, {}, 1000, async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = pool.withServer(`${REPO}/b.go`, {}, 1000, async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
