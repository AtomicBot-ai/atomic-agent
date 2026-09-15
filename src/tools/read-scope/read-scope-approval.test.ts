import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ApprovalGate,
  type ApprovalLevel,
  type ApprovalRequest,
} from "../../approval/index.js";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ReadScope } from "../../config/index.js";
import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { confineReads } from "./confine-reads.js";
import { widenedReadRoot } from "./read-scope-approval.js";
import { READ_REFUSAL_REASON, WORKER_READ_REFUSAL_REASON } from "./read-scope.js";

const WORKER = `${FUSION_WORKER_ID_PREFIX}1`;

describe("a read outside the scope asks through the ladder", () => {
  let work: string;
  let registry: ToolRegistry;
  let gate: ApprovalGate;
  let prompts: ApprovalRequest[];
  let answer: { approved: boolean; grant?: "category" };
  let innerReads: number;
  let innerShells: number;
  let readScope: ReadScope;
  // Lexical and off the temp directory, which is scratch and never asked about.
  const home = "/srv/homes/me";
  const elsewhere = "/srv/homes/other-run/work";
  const solution = join(elsewhere, "solution.js");

  const ctx = (sessionId = "s-plain", readRoots?: readonly string[]): ToolContext => ({
    sessionId,
    workingDir: work,
    stepIndex: 0,
    signal: new AbortController().signal,
    ...(readRoots ? { readRoots } : {}),
  });
  const read = (path: string, c = ctx()) => registry.invoke("os.fs.read", { path }, c);
  const shell = (args: Record<string, unknown>, c = ctx()) =>
    registry.invoke("os.shell.run", args, c);
  const stub = (name: string, count: () => void) => ({
    name,
    description: name,
    readonly: true,
    run: async () => {
      count();
      return compressToolResult({ tool: name, status: "ok", output: "", details: {} });
    },
  });

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "read-ask-"));
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "main.ts"), "mine");
    prompts = [];
    answer = { approved: true };
    innerReads = 0;
    innerShells = 0;
    readScope = "working-dir";
    gate = new ApprovalGate({
      level: 3 as ApprovalLevel,
      emit: (request) => {
        prompts.push(request);
        // Answer on the next tick, the way a surface would.
        queueMicrotask(() =>
          gate.resolve({ approvalId: request.approvalId, ...answer }),
        );
      },
    });
    registry = new ToolRegistry();
    registry.register(stub("os.fs.read", () => (innerReads += 1)));
    registry.register(stub("os.shell.run", () => (innerShells += 1)));
    expect(
      confineReads(registry, {
        grantedDirs: () => [],
        readScope: () => readScope,
        approvals: { approvals: gate, approvalRequired: true },
        shellEnv: { home, platform: "linux" },
      }),
    ).toEqual(["os.fs.read", "os.shell.run"]);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("asks at an asking level, naming the path and the directory a yes widens to", async () => {
    expect((await read(solution)).status).toBe("ok");
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt.tool).toBe("os.fs.read");
    expect(prompt.category).toBe("fs_read_outside");
    expect(prompt.sessionId).toBe("s-plain");
    expect(prompt.reason).toBe(
      `read ${solution} — outside the working directory (${work}); approving allows reads under ${elsewhere} for the rest of this session`,
    );
    expect(prompt.affectedResources).toEqual([elsewhere]);
    expect(prompt.commandShape).toBeUndefined();
    expect(prompt.redirectablePath).toBeUndefined();
    expect(innerReads).toBe(1);
  });

  it("a yes widens the session's roots: the next read under that directory does not ask", async () => {
    await read(solution);
    await read(join(elsewhere, "lib", "other.js"));
    expect(prompts).toHaveLength(1);
    expect(innerReads).toBe(2);
    expect(gate.readScopeGrants.rootsFor("s-plain")).toEqual([elsewhere]);
    // A sibling directory is a new question.
    await read(join(dirname(elsewhere), "sibling", "x.js"));
    expect(prompts).toHaveLength(2);
    // Another session rides nothing of it.
    await read(solution, ctx("s-other"));
    expect(prompts).toHaveLength(3);
  });

  it("a no is the refusal, with the existing sentence, and widens nothing", async () => {
    answer = { approved: false };
    const refused = await read(solution);
    expect(refused.status).toBe("error");
    expect(refused.details.reason).toBe(READ_REFUSAL_REASON);
    expect(refused.summary).toBe(
      `os.fs.read refused: reads are confined to the working directory (${work}) and the paths the user named; ` +
        `ask the user to name ${solution} or to set agent.readScope: unrestricted`,
    );
    expect(innerReads).toBe(0);
    expect(gate.readScopeGrants.rootsFor("s-plain")).toEqual([]);
    // The model may try again; it is asked again.
    answer = { approved: true };
    expect((await read(solution)).status).toBe("ok");
    expect(prompts).toHaveLength(2);
  });

  it("an [s] grant is 'read anywhere this session': later reads elsewhere do not ask", async () => {
    answer = { approved: true, grant: "category" };
    await read(solution);
    await read(join(dirname(elsewhere), "sibling", "x.js"));
    expect(prompts).toHaveLength(1);
    expect(innerReads).toBe(2);
  });

  it("level 5 runs without asking; a user-named path and the working directory never ask at any level", async () => {
    gate.setLevel(5);
    expect((await read(solution)).status).toBe("ok");
    gate.setLevel(1);
    expect((await read("src/main.ts")).status).toBe("ok");
    expect((await read(solution, ctx("s-plain", [elsewhere]))).status).toBe("ok");
    expect(prompts).toHaveLength(0);
    expect(innerReads).toBe(3);
  });

  it("`unrestricted` never asks, live, without a reinstall", async () => {
    readScope = "unrestricted";
    gate.setLevel(1);
    expect((await read(solution)).status).toBe("ok");
    expect((await shell({ cmd: `cat ${solution}` })).status).toBe("ok");
    expect(prompts).toHaveLength(0);
  });

  it("a fusion worker is still refused outright, reads and shell alike", async () => {
    const worker = await read(solution, ctx(WORKER, [elsewhere]));
    expect(worker.status).toBe("error");
    expect(worker.details.reason).toBe(WORKER_READ_REFUSAL_REASON);
    const cmd = await shell({ cmd: `cat ${solution}` }, ctx(WORKER, [elsewhere]));
    expect(cmd.status).toBe("error");
    expect(cmd.details.reason).toBe(WORKER_READ_REFUSAL_REASON);
    expect(cmd.summary).toContain("outside this worker's working directory");
    expect(prompts).toHaveLength(0);
  });

  it("a shell path outside the scope asks under the same category, with the command", async () => {
    // The fixture is lexical (nothing under /srv exists here), so the
    // widened root is the named file's parent — as for a read.
    expect(
      (await shell({ cmd: "grep", args: ["-n", "x", solution] })).status,
    ).toBe("ok");
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt.tool).toBe("os.shell.run");
    expect(prompt.category).toBe("fs_read_outside");
    expect(prompt.reason).toBe(
      `run \`grep -n x ${solution}\` — reads outside the working directory (${work}): ${solution}; approving allows reads under ${elsewhere} for the rest of this session`,
    );
    expect(prompt.preview).toBe(`grep -n x ${solution}`);
    expect(prompt.commandShape).toBeUndefined();
    expect(innerShells).toBe(1);
    // The yes covers a read tool under the same directory too.
    expect((await read(solution)).status).toBe("ok");
    expect(prompts).toHaveLength(1);
    // Denied: the same refusal the read gets.
    answer = { approved: false };
    const refused = await shell({ cmd: `cat ${join(home, "notes.txt")}` });
    expect(refused.status).toBe("error");
    expect(refused.summary).toContain("reads are confined to the working directory");
    expect(innerShells).toBe(1);
  });

  it("parallel reads under one directory ask once: the second waits and re-checks", async () => {
    const results = await Promise.all([
      read(solution),
      read(join(elsewhere, "b.js")),
      read(join(elsewhere, "c.js")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(prompts).toHaveLength(1);
    expect(gate.pendingCount()).toBe(0);
  });

  it("an aborted turn does not park a read on an unanswered prompt", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      read(solution, { ...ctx(), signal: controller.signal }),
    ).rejects.toThrow(/approval aborted/);
    expect(innerReads).toBe(0);
  });

  it("refuses to install a session scope without a ladder to ask through", () => {
    expect(() =>
      confineReads(new ToolRegistry(), {
        grantedDirs: () => [],
        readScope: () => "working-dir",
      }),
    ).toThrow(/approvals/);
  });

  it("widens to a directory itself, or to a file's parent", () => {
    expect(widenedReadRoot(join(work, "src"))).toBe(join(work, "src"));
    expect(widenedReadRoot(join(work, "src", "main.ts"))).toBe(join(work, "src"));
    expect(widenedReadRoot(join(work, "src", "absent.ts"))).toBe(join(work, "src"));
  });
});
