import { describe, expect, it } from "vitest";
import type { DiagnosticsClient } from "./lsp-client.js";
import type { LspDiagnostic } from "./lsp-delta.js";
import {
  createLspDiagnostics,
  type LspChangeInput,
  type LspDiagnosticsOptions,
  type StartClient,
} from "./lsp-diagnostics.js";

/**
 * A fake server: diagnostics are a pure function of the text — one
 * error per line containing `ERR:<text>` — so "before" and "after" are
 * exactly what the test wrote.
 */
class FakeClient implements DiagnosticsClient {
  alive = true;
  disposed = false;
  readonly synced: string[] = [];
  constructor(private readonly answer: "normal" | "silent" = "normal") {}

  async diagnose(
    _path: string,
    _languageId: string,
    text: string,
  ): Promise<LspDiagnostic[] | null> {
    this.synced.push(text);
    if (this.answer === "silent") return null;
    return text.split("\n").flatMap((line, i) => {
      const m = /ERR:(.+)$/.exec(line);
      return m === null
        ? []
        : [{ message: m[1] ?? "", severity: 1, range: { start: { line: i, character: 0 } } }];
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

const REPO = "/work/repo";

function setup(overrides: Partial<LspDiagnosticsOptions> = {}, client = new FakeClient()) {
  const starts: Array<{ id: string; binary: string; root: string }> = [];
  const startClient: StartClient = async (spec, binary, root) => {
    starts.push({ id: spec.id, binary, root });
    return client;
  };
  const lsp = createLspDiagnostics({
    enabled: true,
    findBinary: (command) => `/usr/local/bin/${command}`,
    findRoot: (dir) => (dir.startsWith(REPO) ? REPO : null),
    startClient,
    ...overrides,
  });
  return { lsp, starts, client };
}

function change(over: Partial<LspChangeInput> = {}): LspChangeInput {
  return {
    absolute: `${REPO}/src/a.ts`,
    display: "src/a.ts",
    change: "edit",
    before: "const a = 1;\n// ERR:old problem\n",
    after: "const a = 1;\n// ERR:old problem\n// ERR:new problem\n",
    ...over,
  };
}

describe("createLspDiagnostics (ATO-503)", () => {
  it("does nothing at all when the flag is off", async () => {
    const { lsp, starts } = setup({ enabled: false });
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(starts).toEqual([]);
  });

  it("reports only the error the edit added", async () => {
    const { lsp, starts } = setup();
    const text = await lsp.diagnoseChange(change());
    expect(text).toBe(
      "⚠ src/a.ts: 1 new error from typescript after this edit:\n  line 3:1 new problem",
    );
    expect(starts).toEqual([
      { id: "typescript", binary: "/usr/local/bin/typescript-language-server", root: REPO },
    ]);
  });

  it("is silent when the edit added no errors", async () => {
    const { lsp } = setup();
    expect(
      await lsp.diagnoseChange(change({ after: "const a = 2;\n// ERR:old problem\n" })),
    ).toBeNull();
  });

  it("counts every error of a new file as new", async () => {
    const { lsp, client } = setup();
    const text = await lsp.diagnoseChange(
      change({ change: "write", after: "// ERR:one\n// ERR:two\n", before: undefined }),
    );
    expect(text).toContain("2 new errors from typescript after this write");
    expect(client.synced).toEqual(["// ERR:one\n// ERR:two\n"]);
  });

  it("starts nothing outside a git repository", async () => {
    const { lsp, starts } = setup();
    expect(
      await lsp.diagnoseChange(change({ absolute: "/Users/me/Downloads/a.ts" })),
    ).toBeNull();
    expect(starts).toEqual([]);
  });

  it("starts nothing for a language it has no server for", async () => {
    const { lsp, starts } = setup();
    expect(await lsp.diagnoseChange(change({ absolute: `${REPO}/main.go` }))).toBeNull();
    expect(starts).toEqual([]);
  });

  it("never installs: a server missing from PATH is silence, looked up once", async () => {
    const lookups: string[] = [];
    const { lsp, starts } = setup({
      findBinary: (command) => {
        lookups.push(command);
        return null;
      },
    });
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(starts).toEqual([]);
    expect(lookups).toEqual(["typescript-language-server"]);
  });

  it("picks pyright for Python files", async () => {
    const { lsp, starts } = setup();
    const text = await lsp.diagnoseChange(
      change({ absolute: `${REPO}/app.py`, display: "app.py", before: "x = 1\n", after: "x = 1\n# ERR:bad\n" }),
    );
    expect(text).toContain("from pyright after this edit");
    expect(starts[0]?.binary).toBe("/usr/local/bin/pyright-langserver");
  });

  it("starts one server per language per repository and reuses it", async () => {
    const { lsp, starts } = setup();
    await lsp.diagnoseChange(change());
    await lsp.diagnoseChange(change({ absolute: `${REPO}/src/b.ts` }));
    expect(starts).toHaveLength(1);
  });

  it("is silent when the server gives no verdict in time", async () => {
    const { lsp } = setup({}, new FakeClient("silent"));
    expect(await lsp.diagnoseChange(change())).toBeNull();
  });

  it("is silent, and does not retry, when the server cannot start", async () => {
    let attempts = 0;
    const { lsp } = setup({
      startClient: async () => {
        attempts += 1;
        throw new Error("spawn ENOENT");
      },
    });
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(attempts).toBe(1);
  });

  it("does not hold the edit for a server that is slow to start", async () => {
    const { lsp } = setup({
      startupWaitMs: 10,
      startClient: () => new Promise<DiagnosticsClient>(() => {}),
    });
    expect(await lsp.diagnoseChange(change())).toBeNull();
  });

  it("starts a server again after the old one died", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const clients = [first, second];
    const { lsp } = setup({ startClient: async () => clients.shift() ?? second });
    await lsp.diagnoseChange(change());
    first.alive = false;
    expect(await lsp.diagnoseChange(change())).toContain("new problem");
    expect(second.synced.length).toBeGreaterThan(0);
  });

  it("never throws, even when the client does", async () => {
    const broken: DiagnosticsClient = {
      alive: true,
      diagnose: () => Promise.reject(new Error("pipe closed")),
      dispose: () => {},
    };
    const { lsp } = setup({}, broken as FakeClient);
    await expect(lsp.diagnoseChange(change())).resolves.toBeNull();
    // The queue survives a failed sync.
    await expect(lsp.diagnoseChange(change())).resolves.toBeNull();
  });

  it("runs before/after pairs for one server one at a time", async () => {
    const order: string[] = [];
    const slow: DiagnosticsClient = {
      alive: true,
      async diagnose(_p, _l, text) {
        order.push(`start ${text}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${text}`);
        return [];
      },
      dispose: () => {},
    };
    const { lsp } = setup({}, slow as FakeClient);
    await Promise.all([
      lsp.diagnoseChange(change({ before: "a0", after: "a1" })),
      lsp.diagnoseChange(change({ before: "b0", after: "b1" })),
    ]);
    expect(order).toEqual([
      "start a0", "end a0", "start a1", "end a1",
      "start b0", "end b0", "start b1", "end b1",
    ]);
  });

  it("disposes every server it started", async () => {
    const { lsp, client } = setup();
    await lsp.diagnoseChange(change());
    lsp.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(client.disposed).toBe(true);
  });
});
