import { describe, expect, it } from "vitest";
import type { DiagnosticsClient } from "./lsp-client.js";
import type { LspDiagnostic } from "./lsp-delta.js";
import {
  createLspDiagnostics,
  type LspChangeInput,
  type LspDiagnosticsOptions,
  type LspStartAnswer,
  type LspStartQuestion,
  type StartClient,
} from "./lsp-diagnostics.js";
import { askToStartLspThroughApprovals, LSP_START_TOOL } from "./lsp-start-question.js";

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

describe("start question in an untrusted folder (ATO-503)", () => {
  function asking(answers: LspStartAnswer[]) {
    const questions: LspStartQuestion[] = [];
    const askToStart = async (question: LspStartQuestion): Promise<LspStartAnswer> => {
      questions.push(question);
      return answers.shift() ?? "unanswered";
    };
    return { questions, askToStart };
  }
  const inSession = (over: Partial<LspChangeInput> = {}) => change({ sessionId: "s1", ...over });

  it("asks on the first start in an untrusted work tree, and not on the second", async () => {
    const { questions, askToStart } = asking(["yes"]);
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    expect(await lsp.diagnoseChange(inSession())).toContain("new problem");
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ root: REPO, server: "typescript-language-server", sessionId: "s1" });
    expect(await lsp.diagnoseChange(inSession())).toContain("new problem");
    expect(questions).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it("remembers the answer for the work tree, not per language", async () => {
    const { questions, askToStart } = asking(["yes"]);
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    await lsp.diagnoseChange(inSession());
    await lsp.diagnoseChange(inSession({ absolute: `${REPO}/tool.py`, display: "tool.py" }));
    expect(questions).toHaveLength(1);
    expect(starts.map((s) => s.id).sort()).toEqual(["pyright", "typescript"].sort());
  });

  it("does not ask in a trusted folder", async () => {
    const { questions, askToStart } = asking([]);
    const trustedRoots: string[] = [];
    const { lsp, starts } = setup({
      askToStart,
      isTrustedProject: (root) => {
        trustedRoots.push(root);
        return true;
      },
    });
    expect(await lsp.diagnoseChange(inSession())).toContain("new problem");
    expect(questions).toEqual([]);
    expect(trustedRoots).toEqual([REPO]);
    expect(starts).toHaveLength(1);
  });

  it("starts nothing on a no, and remembers it", async () => {
    const { questions, askToStart } = asking(["no"]);
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    expect(await lsp.diagnoseChange(inSession())).toBeNull();
    expect(await lsp.diagnoseChange(inSession())).toBeNull();
    expect(questions).toHaveLength(1);
    expect(starts).toEqual([]);
  });

  it("starts nothing when nobody could answer, and asks again next time", async () => {
    const { questions, askToStart } = asking(["unanswered", "yes"]);
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    expect(await lsp.diagnoseChange(inSession())).toBeNull();
    expect(starts).toEqual([]);
    expect(await lsp.diagnoseChange(inSession())).toContain("new problem");
    expect(questions).toHaveLength(2);
    expect(starts).toHaveLength(1);
  });

  it("asks once for edits that arrive while the question is open", async () => {
    let answer: (a: LspStartAnswer) => void = () => {};
    let asked = 0;
    const askToStart = () => {
      asked += 1;
      return new Promise<LspStartAnswer>((resolve) => {
        answer = resolve;
      });
    };
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    const a = lsp.diagnoseChange(inSession());
    const b = lsp.diagnoseChange(inSession());
    await new Promise((r) => setTimeout(r, 0));
    answer("yes");
    await Promise.all([a, b]);
    expect(asked).toBe(1);
    expect(starts).toHaveLength(1);
  });

  it("starts nothing without a session to ask in", async () => {
    const { questions, askToStart } = asking(["yes"]);
    const { lsp, starts } = setup({ askToStart, isTrustedProject: () => false });
    expect(await lsp.diagnoseChange(change())).toBeNull();
    expect(questions).toEqual([]);
    expect(starts).toEqual([]);
  });
});

describe("askToStartLspThroughApprovals (ATO-503)", () => {
  const question: LspStartQuestion = {
    root: REPO,
    server: "typescript-language-server",
    sessionId: "s1",
    signal: new AbortController().signal,
  };
  function gate(decision: { approved: boolean; automatic?: boolean; declinedEarlier?: boolean }) {
    const requests: Array<{ tool: string; category: string; sessionId: string }> = [];
    const approvals = {
      request: async (req: { tool: string; category: string; sessionId: string }) => {
        requests.push(req);
        return decision;
      },
    };
    return { requests, ask: askToStartLspThroughApprovals({ approvals: approvals as never, approvalRequired: true }) };
  }

  it("asks as trust_config and maps a yes", async () => {
    const { requests, ask } = gate({ approved: true });
    await expect(ask(question)).resolves.toBe("yes");
    expect(requests[0]).toMatchObject({ tool: LSP_START_TOOL, category: "trust_config", sessionId: "s1" });
  });

  it("maps a person's no to no, and a refuse policy to unanswered", async () => {
    await expect(gate({ approved: false }).ask(question)).resolves.toBe("no");
    await expect(gate({ approved: false, automatic: true }).ask(question)).resolves.toBe("unanswered");
  });
});
