import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../approval/approval-gate.js";
import { quotedRequestText } from "../../prompt/request-section.js";
import { findUnknownArguments } from "../unknown-argument-guard.js";
import { renderWorkerBrief } from "../fusion/worker-prompt.js";
import type { ToolContext } from "../tool-registry.js";
import { DeclaredInputsRegistry } from "./fs-declared-inputs.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import {
  REPLACE_VERB_WINDOW_WORDS,
  requestAsksToReplace,
  requestNamesFile,
} from "./fs-input-guard.js";
import { FileRestoreStore, RESTORE_MAX_BYTES } from "./fs-restore-store.js";
import { buildOsFsWriteTool } from "./fs-write.js";

/**
 * F51. Live, five first attempts across two local models failed by
 * rewriting the file the request named as the input (`projects.json`,
 * `sales.csv`) from memory; F36 warned and saved, and the write landed.
 * The rule pinned here: `os.fs.write` refuses to replace a pre-existing
 * file the agent did not create when the pinned request names it —
 * unless the call carries `overwrite: true` or the request itself asks
 * for the file to be replaced. Edits and patches are never refused.
 */
describe("input guard rules (F51)", () => {
  it("names a file as a whole name, case-insensitively, with or without a path", () => {
    expect(requestNamesFile("Analyse sales.csv and write a report", "sales.csv")).toBe(true);
    expect(requestNamesFile("Analyse data/sales.csv", "sales.csv")).toBe(true);
    expect(requestNamesFile("Analyse `Sales.CSV`.", "sales.csv")).toBe(true);
    expect(requestNamesFile("Update sales.csv.", "sales.csv")).toBe(true);
    expect(requestNamesFile("Analyse old-sales.csv", "sales.csv")).toBe(false);
    expect(requestNamesFile("Analyse sales.csv.bak", "sales.csv")).toBe(false);
    expect(requestNamesFile("Analyse sales.csv2", "sales.csv")).toBe(false);
    expect(requestNamesFile("Analyse the sales", "sales.csv")).toBe(false);
    expect(requestNamesFile("", "sales.csv")).toBe(false);
  });

  it(`lifts the rule for a name within ${REPLACE_VERB_WINDOW_WORDS} words after a replace verb, in the same sentence`, () => {
    expect(requestAsksToReplace("Rewrite sales.csv from the spec", "sales.csv")).toBe(true);
    expect(requestAsksToReplace("regenerate the file sales.csv", "sales.csv")).toBe(true);
    expect(requestAsksToReplace("Replace the header row in data/sales.csv", "sales.csv")).toBe(true);
    expect(requestAsksToReplace("Replacing (sales.csv) is fine.", "sales.csv")).toBe(true);
    expect(requestAsksToReplace("overwrite: sales.csv", "sales.csv")).toBe(true);
    // Too far after the verb.
    expect(
      requestAsksToReplace("reset the whole thing and then a few more words sales.csv", "sales.csv"),
    ).toBe(false);
    // The sentence ended before the name.
    expect(requestAsksToReplace("Rewrite the parser. Keep sales.csv as it is", "sales.csv")).toBe(false);
    // Negated verbs do not lift it.
    expect(requestAsksToReplace("do not overwrite sales.csv", "sales.csv")).toBe(false);
    expect(requestAsksToReplace("never replace sales.csv", "sales.csv")).toBe(false);
    expect(requestAsksToReplace("instead of rewriting sales.csv", "sales.csv")).toBe(false);
    expect(requestAsksToReplace("rather than replacing sales.csv", "sales.csv")).toBe(false);
    // No verb at all.
    expect(requestAsksToReplace("Clean sales.csv and save clean.csv", "sales.csv")).toBe(false);
  });

  it("reads only the ORIGINAL REQUEST block of a worker's brief", () => {
    const brief = renderWorkerBrief(
      { id: "t1", title: "T", instructions: "Rewrite notes.md", files: ["notes.md"] },
      { workingDir: "/repo", originalRequest: "Summarise sales.csv" },
    );
    expect(quotedRequestText(brief).trim()).toBe("Summarise sales.csv");
    expect(quotedRequestText("Summarise sales.csv")).toBe("Summarise sales.csv");
  });

  it("declares `overwrite` to the unknown-key guard (F40)", () => {
    expect(
      findUnknownArguments("os.fs.write", { path: "a", content: "b", overwrite: true }),
    ).toBeNull();
    expect(
      findUnknownArguments("os.fs.write", { path: "a", content: "b", overwrit: true })?.nearest,
    ).toEqual([{ received: "overwrit", expected: "overwrite" }]);
  });
});

describe("os.fs.write refuses to replace an input the request names (F51)", () => {
  let dir: string;
  let stateDir: string;
  let store: FileRestoreStore;
  let prompts: ApprovalRequest[];
  let gate: ApprovalGate;
  let request: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-input-guard-"));
    stateDir = await mkdtemp(join(tmpdir(), "atomic-input-guard-state-"));
    store = new FileRestoreStore(join(stateDir, "restore"));
    prompts = [];
    gate = new ApprovalGate({
      emit: (req) => {
        prompts.push(req);
        gate.resolve({ approvalId: req.approvalId, approved: true });
      },
    });
    request = "Clean sales.csv: drop rows with an empty amount and save the result to clean.csv";
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  function ctx(sessionId = "s-input"): ToolContext {
    return {
      workingDir: dir,
      sessionId,
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  }

  function tools(restore: FileRestoreStore | null = store) {
    const options = {
      approvals: gate,
      approvalRequired: true,
      ...(restore === null ? {} : { restore }),
      resolveOriginalRequest: () => request,
    };
    return {
      write: buildOsFsWriteTool(options),
      edit: buildOsFsEditTool(options),
    };
  }

  function csv(rows: number, header = "id,name,amount"): string {
    const lines = [header];
    for (let i = 1; i <= rows; i++) lines.push(`${i},row ${i},${i * 10}`);
    return `${lines.join("\n")}\n`;
  }

  const REFUSAL =
    "refused: sales.csv is an input the request names (2,402 lines → 10); edit it in place (os.fs.edit / os.fs.patch), or pass overwrite: true if replacing it is really what the user asked for";

  it("refuses before the approval prompt, leaves the file alone, and names the way onward", async () => {
    const before = csv(2401);
    await writeFile(join(dir, "sales.csv"), before, "utf8");
    const result = await tools().write.run(
      { path: "sales.csv", content: csv(9, "sku,qty") },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.summary).toBe(REFUSAL);
    expect(result.details).toMatchObject({
      refused: "input",
      input: "request",
      path: join(dir, "sales.csv"),
      display: "sales.csv",
      linesBefore: 2402,
      linesAfter: 10,
      overwrite: false,
    });
    expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);
    expect(prompts).toHaveLength(0);
    expect(await store.listCopies(dir)).toEqual([]);
  });

  it("lands with overwrite: true, through the approval and the F36 note", async () => {
    await writeFile(join(dir, "sales.csv"), csv(2401), "utf8");
    const after = csv(9, "sku,qty");
    const result = await tools().write.run(
      { path: "sales.csv", content: after, overwrite: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary.split("\n")[0]).toBe(
      '⚠ replaced the user\'s file `sales.csv` (2,402 lines → 10, header changed); the previous content is saved — `os.fs.restore {"path":"sales.csv"}` brings it back',
    );
    expect(result.details.overwrite).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(after);
  });

  it("is lifted when the request itself asks for the file to be replaced", async () => {
    request = "Rewrite sales.csv with only the 2024 rows";
    await writeFile(join(dir, "sales.csv"), csv(50), "utf8");
    const result = await tools().write.run(
      { path: "sales.csv", content: csv(3) },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("replaced the user's file `sales.csv`");
  });

  it("never refuses a file this session created, an edit, an append, or a new file", async () => {
    request = "Write out/report.md from sales.csv and keep notes.txt up to date";
    const t = tools();
    const created = await t.write.run(
      { path: "out/report.md", content: "# Report\n" },
      ctx(),
    );
    expect(created.status).toBe("ok");
    const again = await t.write.run(
      { path: "out/report.md", content: "# Done\n" },
      ctx(),
    );
    expect(again.status).toBe("ok");
    expect(again.details.replaced).toBeUndefined();

    await writeFile(join(dir, "sales.csv"), csv(100), "utf8");
    const edited = await t.edit.run(
      { path: "sales.csv", oldString: "row 1,", newString: "row one," },
      ctx(),
    );
    expect(edited.status).toBe("ok");

    await writeFile(join(dir, "notes.txt"), "a\n", "utf8");
    const appended = await t.write.run(
      { path: "notes.txt", content: "b\n", mode: "append" },
      ctx(),
    );
    expect(appended.status).toBe("ok");
    expect(await readFile(join(dir, "notes.txt"), "utf8")).toBe("a\nb\n");
  });

  it("says nothing without a pinned request, without a store, for an empty file, or for a file the request does not name", async () => {
    await writeFile(join(dir, "sales.csv"), csv(20), "utf8");
    request = undefined;
    expect((await tools().write.run({ path: "sales.csv", content: "x\n" }, ctx())).status).toBe("ok");

    await writeFile(join(dir, "sales.csv"), csv(20), "utf8");
    request = "Clean sales.csv";
    expect((await tools(null).write.run({ path: "sales.csv", content: "x\n" }, ctx())).status).toBe("ok");

    await writeFile(join(dir, "empty.csv"), "", "utf8");
    request = "Fill empty.csv";
    expect((await tools().write.run({ path: "empty.csv", content: "x\n" }, ctx())).status).toBe("ok");

    await writeFile(join(dir, "other.csv"), csv(20), "utf8");
    request = "Clean sales.csv";
    const other = await tools().write.run({ path: "other.csv", content: "x\n" }, ctx());
    expect(other.status).toBe("ok");
    expect(other.summary).toContain("replaced the user's file `other.csv`");
  });

  it("names the path as the call spelled it, and a file too large to read by its size", async () => {
    await writeFile(join(dir, "data.csv"), csv(5), "utf8");
    request = "Summarise data/data.csv";
    const spelled = await tools().write.run(
      { path: join(dir, "data.csv"), content: "x\n" },
      ctx(),
    );
    expect(spelled.summary).toBe(
      `refused: ${join(dir, "data.csv")} is an input the request names (6 lines → 1); edit it in place (os.fs.edit / os.fs.patch), or pass overwrite: true if replacing it is really what the user asked for`,
    );

    await writeFile(join(dir, "huge.bin"), Buffer.alloc(RESTORE_MAX_BYTES + 1, 0x61));
    request = "Inspect huge.bin";
    const huge = await tools().write.run({ path: "huge.bin", content: "tiny\n" }, ctx());
    expect(huge.summary).toBe(
      "refused: huge.bin is an input the request names (5.0 MB → 1 line); edit it in place (os.fs.edit / os.fs.patch), or pass overwrite: true if replacing it is really what the user asked for",
    );
    expect(existsSync(join(dir, "huge.bin"))).toBe(true);
  });

  it("guards a fusion worker by the ORIGINAL REQUEST block of its brief, not by its task", async () => {
    // The task names notes.md as its output and tells the worker to
    // rewrite it; the operator named sales.csv. Only the latter is an input.
    request = renderWorkerBrief(
      { id: "t1", title: "Notes", instructions: "Rewrite notes.md from scratch", files: ["notes.md"] },
      { workingDir: dir, originalRequest: "Clean sales.csv and write notes.md" },
    );
    await writeFile(join(dir, "sales.csv"), csv(2401), "utf8");
    await writeFile(join(dir, "notes.md"), "old notes\n", "utf8");
    const t = tools();
    const notes = await t.write.run(
      { path: "notes.md", content: "new notes\n" },
      ctx("s-w-1"),
    );
    // notes.md IS named by the operator too — but only as an output
    // the worker was told to rewrite; the request names both.
    expect(notes.status).toBe("error");
    expect(notes.summary).toContain("notes.md is an input the request names");
    request = renderWorkerBrief(
      { id: "t1", title: "Notes", instructions: "Rewrite notes.md from scratch", files: ["notes.md"] },
      { workingDir: dir, originalRequest: "Clean sales.csv" },
    );
    const rewritten = await t.write.run(
      { path: "notes.md", content: "new notes\n" },
      ctx("s-w-1"),
    );
    expect(rewritten.status).toBe("ok");
    const sales = await t.write.run(
      { path: "sales.csv", content: csv(9, "sku,qty") },
      ctx("s-w-1"),
    );
    expect(sales.status).toBe("error");
    expect(sales.summary).toBe(REFUSAL);
  });

  it("refuses a worker's write to a declared input whatever overwrite says, without a store or a request; edits stay fine", async () => {
    const registry = new DeclaredInputsRegistry();
    registry.declare("s-w-1", [join(dir, "sales.csv"), "relative/ignored.csv"]);
    expect(registry.inputsOf("s-w-1")).toEqual([join(dir, "sales.csv")]);
    expect(registry.inputsOf("s-other")).toEqual([]);
    request = undefined;
    const before = csv(2401);
    await writeFile(join(dir, "sales.csv"), before, "utf8");
    const options = { approvals: gate, approvalRequired: true, declaredInputs: registry };
    const write = buildOsFsWriteTool(options);
    const refused = await write.run(
      { path: "sales.csv", content: csv(9, "sku,qty"), overwrite: true },
      ctx("s-w-1"),
    );
    expect(refused.status).toBe("error");
    expect(refused.summary).toBe(
      "refused: sales.csv is an input this fan-out declared (2,402 lines → 10); edit it in place (os.fs.edit / os.fs.patch) — a worker cannot replace a declared input; if the task needs it replaced, say so in your reply so the orchestrator can redeclare it",
    );
    expect(refused.details).toMatchObject({
      refused: "input",
      input: "contract",
      overwrite: true,
    });
    expect(prompts).toHaveLength(0);
    expect(await readFile(join(dir, "sales.csv"), "utf8")).toBe(before);
    // An edit in place is the point.
    const edited = await buildOsFsEditTool(options).run(
      { path: "sales.csv", oldString: "row 1,", newString: "row one," },
      ctx("s-w-1"),
    );
    expect(edited.status).toBe("ok");
    // Another session is not bound; after `clear`, neither is the worker.
    expect(
      (await write.run({ path: "sales.csv", content: csv(9) }, ctx("s-other"))).status,
    ).toBe("ok");
    registry.clear("s-w-1");
    expect(
      (await write.run({ path: "sales.csv", content: csv(9) }, ctx("s-w-1"))).status,
    ).toBe("ok");
  });
});
