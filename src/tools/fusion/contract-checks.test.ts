import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyCheckOutcomes,
  applyContractFindings,
  contentProvides,
  describeMissing,
  inspectContractProvides,
  renderContractLine,
  runContractChecks,
  type ContractCheckRunner,
  type ContractFinding,
} from "./contract-checks.js";
import type { DelegateContract } from "./contract.js";
import type { DelegateTask } from "./delegate-args.js";
import type { WorkerTaskResult } from "./worker-result.js";

function row(over: Partial<WorkerTaskResult> = {}): WorkerTaskResult {
  return {
    id: "t1",
    title: "T",
    status: "ok",
    reply: "done",
    stepCount: 1,
    durationMs: 1,
    tools: { calls: 0, errors: 0, writes: 0, byTool: {} },
    ...over,
  };
}

describe("contentProvides", () => {
  it("matches a symbol as a whole word, dots included", () => {
    expect(contentProvides("const x = HD.Ship.reset();", { kind: "symbol", name: "HD.Ship.reset" })).toBe(true);
    // `HD.Shipyard` must not pass for `HD.Ship`.
    expect(contentProvides("HD.Shipyard = {}", { kind: "symbol", name: "HD.Ship" })).toBe(false);
    expect(contentProvides("myHD.Ship = 1", { kind: "symbol", name: "HD.Ship" })).toBe(false);
    // `$` is an identifier character; `\b` alone would misread it.
    expect(contentProvides("function $init() {}", { kind: "symbol", name: "$init" })).toBe(true);
    expect(contentProvides("function x$init() {}", { kind: "symbol", name: "$init" })).toBe(false);
  });

  it("matches an id attribute in either quote and nothing else", () => {
    expect(contentProvides('<button id="btn-launch">', { kind: "id", name: "btn-launch" })).toBe(true);
    expect(contentProvides("<button id='btn-launch'>", { kind: "id", name: "btn-launch" })).toBe(true);
    // Mentioned, but not as an id: the run-14 `launch-btn` failure mode.
    expect(contentProvides('getElementById("btn-launch")', { kind: "id", name: "btn-launch" })).toBe(false);
    expect(contentProvides('<button id="launch-btn">', { kind: "id", name: "btn-launch" })).toBe(false);
  });

  it("matches everything else as a literal", () => {
    expect(contentProvides("app.get('/api/score', …)", { kind: "endpoint", name: "/api/score" })).toBe(true);
    expect(contentProvides("process.env.HD_SEED", { kind: "env", name: "HD_SEED" })).toBe(true);
    expect(contentProvides("--dry-run", { kind: "flag", name: "--dry-run" })).toBe(true);
    expect(contentProvides("nothing here", { kind: "other", name: "x.y" })).toBe(false);
  });
});

describe("inspectContractProvides", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fusion-contract-"));
    mkdirSync(join(dir, "js"));
    writeFileSync(join(dir, "js", "ship.js"), "HD.Ship = class {}; HD.Ship.reset = () => {};");
    writeFileSync(join(dir, "index.html"), '<button id="launch-btn">Go</button>');
    writeFileSync(join(dir, "js", "main.js"), "fetch('/api/score')");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const tasks: DelegateTask[] = [
    { id: "ship", title: "Ship", instructions: "x" },
    { id: "html", title: "Html", instructions: "x", files: ["index.html"] },
    { id: "main", title: "Main", instructions: "x" },
    { id: "lost", title: "Lost", instructions: "x" },
  ];

  it("checks each provide where the contract says to look, and says where it looked", async () => {
    const contract: DelegateContract = {
      owners: { "js/main.js": "main" },
      provides: [
        { task: "ship", kind: "symbol", name: "HD.Ship.reset", in: "js/ship.js" },
        { task: "ship", kind: "symbol", name: "HD.Ship.fire", in: "js/ship.js" },
        // No `in`: the task's declared files.
        { task: "html", kind: "id", name: "btn-launch" },
        // No `in`: the owned path.
        { task: "main", kind: "endpoint", name: "/api/score" },
        { task: "ship", kind: "file", name: "js/ship.js" },
        { task: "ship", kind: "file", name: "js/hud.js" },
        { task: "ship", kind: "symbol", name: "X", in: "js/nope.js" },
        // Nowhere to look: the parser's warning, not a finding — a
        // "missing" verdict over a search that never happened would
        // read as the worker's failure.
        { task: "lost", kind: "symbol", name: "Y" },
      ],
    };
    const findings = await inspectContractProvides(contract, tasks, dir);
    expect(findings.map((f) => [f.name, f.present, f.where])).toEqual([
      ["HD.Ship.reset", true, ["js/ship.js"]],
      ["HD.Ship.fire", false, ["js/ship.js"]],
      ["btn-launch", false, ["index.html"]],
      ["/api/score", true, ["js/main.js"]],
      ["js/ship.js", true, ["js/ship.js"]],
      ["js/hud.js", false, ["js/hud.js"]],
      ["X", false, ["js/nope.js"]],
    ]);
    expect(findings[6]!.detail).toBe("file missing or unreadable");
    expect(describeMissing(findings[1]!)).toBe(
      "[ship] symbol HD.Ship.fire not in js/ship.js",
    );
    expect(describeMissing(findings[2]!)).toBe("[html] id btn-launch not in index.html");
    expect(describeMissing(findings[5]!)).toBe("[ship] file js/hud.js does not exist");
  });

  it("is satisfied by any one of several owned paths", async () => {
    const contract: DelegateContract = {
      owners: { "index.html": "ship", "js/ship.js": "ship" },
      provides: [{ task: "ship", kind: "symbol", name: "HD.Ship" }],
    };
    const [finding] = await inspectContractProvides(contract, tasks, dir);
    expect(finding).toMatchObject({ present: true, where: ["index.html", "js/ship.js"] });
  });
});

describe("applyContractFindings", () => {
  it("notes each missing provide on its owner's row without changing the status", () => {
    const findings: ContractFinding[] = [
      { task: "t1", kind: "symbol", name: "A", where: ["a.js"], present: false },
      { task: "t1", kind: "id", name: "b", where: ["i.html"], present: true },
      { task: "t2", kind: "file", name: "c.js", where: ["c.js"], present: false },
    ];
    const out = applyContractFindings(
      [row(), row({ id: "t2", notes: ["earlier"] }), row({ id: "t3" })],
      findings,
    );
    expect(out[0]).toMatchObject({ status: "ok", notes: ["contract: symbol A not in a.js"] });
    expect(out[1]!.notes).toEqual(["earlier", "contract: file c.js does not exist"]);
    expect(out[2]).not.toHaveProperty("notes");
  });
});

describe("runContractChecks", () => {
  const ctx = { workingDir: "/repo", signal: new AbortController().signal };

  it("reports declared checks as NOT RUN when no runner is wired — never as passed", async () => {
    const out = await runContractChecks([{ kind: "command", cmd: "x" }], undefined, ctx);
    expect(out.outcomes).toEqual([]);
    expect(out.checksSkipped).toBe("1 check not run — no check runner is wired");
  });

  it("does nothing for an empty list", async () => {
    const runner = vi.fn<ContractCheckRunner>();
    expect(await runContractChecks([], runner, ctx)).toEqual({ outcomes: [] });
    expect(runner).not.toHaveBeenCalled();
  });

  it("hands the runner the specs WITHOUT the task key and pairs results back by index", async () => {
    const runner = vi.fn<ContractCheckRunner>(async (specs) => ({
      ok: false,
      results: specs.map((s, i) =>
        i === 0
          ? { ok: true, summary: "exit 0" }
          : { ok: false, summary: `${s.cmd as string}: exit code 1\nline two` },
      ),
    }));
    const out = await runContractChecks(
      [
        { task: "a", kind: "command", cmd: "node" },
        { kind: "command", cmd: "npm" },
      ],
      runner,
      ctx,
    );
    expect(runner).toHaveBeenCalledWith(
      [{ kind: "command", cmd: "node" }, { kind: "command", cmd: "npm" }],
      ctx,
    );
    expect(out.outcomes).toEqual([
      { task: "a", ok: true, detail: "exit 0" },
      { ok: false, detail: "npm: exit code 1 line two" },
    ]);
  });

  it("marks a check the runner returned nothing for as failed, and survives a runner that throws", async () => {
    const short = await runContractChecks(
      [{ task: "a", cmd: "x" }, { task: "b", cmd: "y" }],
      async () => ({ ok: true, results: [{ ok: true }] }),
      ctx,
    );
    expect(short.outcomes).toEqual([
      { task: "a", ok: true, detail: "passed" },
      { task: "b", ok: false, detail: "the runner returned no result" },
    ]);
    const thrown = await runContractChecks(
      [{ cmd: "x" }],
      async () => {
        throw new Error("no browser available");
      },
      ctx,
    );
    expect(thrown.outcomes).toEqual([]);
    expect(thrown.checksSkipped).toBe(
      "1 check not run — the check runner failed: no browser available",
    );
  });

  it("skips the checks when the turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = vi.fn<ContractCheckRunner>();
    const out = await runContractChecks([{ cmd: "x" }, { cmd: "y" }], runner, {
      workingDir: "/repo",
      signal: controller.signal,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(out.checksSkipped).toBe("2 checks not run — the turn was cancelled");
  });
});

describe("applyCheckOutcomes", () => {
  it("fails a task whose declared check failed, with `checks:` as the error", () => {
    const out = applyCheckOutcomes(
      [row(), row({ id: "t2" })],
      [
        { task: "t1", ok: true, detail: "exit 0" },
        { task: "t1", ok: false, detail: "no errors: 1 pageerror" },
        { task: "t2", ok: true, detail: "exit 0" },
      ],
    );
    expect(out[0]).toMatchObject({
      status: "failed",
      error: "checks: no errors: 1 pageerror",
      checks: { total: 2, failed: 1, detail: "no errors: 1 pageerror" },
    });
    expect(out[1]).toMatchObject({ status: "ok", checks: { total: 1, failed: 0 } });
    expect(out[1]!.checks).not.toHaveProperty("detail");
  });

  it("keeps an existing error behind the checks verdict, and leaves a cancelled task cancelled", () => {
    const out = applyCheckOutcomes(
      [
        row({ status: "max_steps", error: "boom" }),
        row({ id: "t2", status: "cancelled" }),
        row({ id: "t3" }),
      ],
      [
        { task: "t1", ok: false, detail: "exit code 1" },
        { task: "t2", ok: false, detail: "exit code 1" },
        // A call-level check touches no row.
        { ok: false, detail: "status 500" },
      ],
    );
    expect(out[0]).toMatchObject({ status: "failed", error: "checks: exit code 1; boom" });
    expect(out[1]).toMatchObject({ status: "cancelled", checks: { failed: 1 } });
    expect(out[1]).not.toHaveProperty("error");
    expect(out[2]).not.toHaveProperty("checks");
  });
});

describe("renderContractLine", () => {
  const present: ContractFinding = { task: "a", kind: "file", name: "a.js", where: ["a.js"], present: true };
  const missing: ContractFinding = { task: "b", kind: "symbol", name: "HD.Ship.reset", where: ["js/ship.js"], present: false };

  it("leads with the missing provides, owner first", () => {
    expect(renderContractLine({ findings: [present, missing], checks: [] })).toBe(
      "contract: 1 missing — [b] symbol HD.Ship.reset not in js/ship.js",
    );
    expect(renderContractLine({ findings: [present], checks: [] })).toBe(
      "contract: all 1 provide present",
    );
  });

  it("carries call-level check failures and the reason checks did not run", () => {
    expect(
      renderContractLine({
        findings: [],
        checks: [{ ok: false, detail: "status 500" }, { task: "a", ok: true, detail: "ok" }],
      }),
    ).toBe("contract: call-level checks: 1 of 1 failed — status 500");
    expect(
      renderContractLine({
        findings: [],
        checks: [{ task: "a", ok: false, detail: "x" }, { task: "a", ok: true, detail: "y" }],
      }),
    ).toBe("contract: checks: 1 of 2 failed (see the task rows)");
    expect(
      renderContractLine({ findings: [], checks: [], checksSkipped: "2 checks not run — no check runner is wired" }),
    ).toBe("contract: 2 checks not run — no check runner is wired");
  });

  it("carries the warnings the call ran with, after everything else", () => {
    const warning =
      'requires "organized_files" (task index) has no provider — nothing produces it';
    expect(
      renderContractLine({ findings: [], checks: [], warnings: [warning] }),
    ).toBe(`contract: ${warning}`);
    expect(
      renderContractLine({ findings: [present], checks: [], warnings: [warning] }),
    ).toBe(`contract: all 1 provide present; ${warning}`);
  });

  it("is absent when there was nothing to report", () => {
    expect(renderContractLine({ findings: [], checks: [] })).toBeUndefined();
    expect(renderContractLine({ findings: [], checks: [], warnings: [] })).toBeUndefined();
  });
});
