import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { OS_FS_READ_CONTRACT, parseReadArgs } from "./fs-read-contract.js";
import { OS_FS_LIST_CONTRACT, normaliseExt, parseListArgs } from "./fs-list-contract.js";
import { OS_FS_DIFF_CONTRACT, parseDiffArgs } from "./fs-diff-contract.js";
import { OS_FS_EDIT_CONTRACT, parseEditArgs } from "./fs-edit-contract.js";
import { osFsReadTool } from "./fs-read.js";
import { osFsListTool } from "./fs-list.js";
import { osFsDiffTool } from "./fs-diff.js";
import { buildOsFsEditTool } from "./fs-edit.js";
import { READ_COVERAGE_DETAIL_KEY } from "./fs-read-coverage.js";

const approvals = new ApprovalGate({
  emit: () => { throw new Error("fixture must not request approval"); },
});
const editTool = buildOsFsEditTool({ approvals, approvalRequired: false });

describe("read/list/diff/edit canonical argument seams", () => {
  let workingDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workingDir = await mkdtemp(join(tmpdir(), "atomic-fs-read-contracts-"));
    ctx = {
      workingDir,
      sessionId: "contract-seams",
      stepIndex: 0,
      signal: new AbortController().signal,
    };
  });

  afterEach(async () => {
    await rm(workingDir, { recursive: true, force: true });
  });

  it("uses canonical definition metadata without replacing execution", () => {
    for (const { tool, contract } of [
      { tool: osFsReadTool, contract: OS_FS_READ_CONTRACT },
      { tool: osFsListTool, contract: OS_FS_LIST_CONTRACT },
      { tool: osFsDiffTool, contract: OS_FS_DIFF_CONTRACT },
      { tool: editTool, contract: OS_FS_EDIT_CONTRACT },
    ]) {
      expect(tool.name).toBe(contract.name);
      expect(tool.description).toBe(contract.description);
      expect(tool.readonly).toBe(contract.readonly);
    }
    expect(OS_FS_EDIT_CONTRACT.resourceClass).toBe("approval_gated");
    expect(OS_FS_READ_CONTRACT.resourceClass).toBe("pure_read");
  });

  it("retains repeated numeric getter reads and short-circuits after an invalid path", () => {
    const reads: string[] = [];
    const parsed = parseReadArgs({
      path: "data.txt",
      get maxBytes() { reads.push("maxBytes"); return 3.8; },
      get offset() { reads.push("offset"); return -2.8; },
      get limit() { reads.push("limit"); return 1.8; },
    });
    expect(parsed).toMatchObject({ maxBytes: 3, offset: -2, limit: 1 });
    expect(reads).toEqual([
      "maxBytes", "maxBytes", "maxBytes",
      "offset", "offset", "offset",
      "limit", "limit", "limit",
    ]);
    expect(() => parseReadArgs({
      path: "",
      get maxBytes() { throw new Error("late getter must not run"); },
    })).toThrow("os.fs.read: `path` must be a non-empty string");
  });

  it("connects negative line ranges to unchanged read coverage and visible numbering", async () => {
    await writeFile(join(workingDir, "data.txt"), "alpha\nbeta\ngamma\n");
    const result = await osFsReadTool.run({
      path: "data.txt", offset: -2, limit: 1, lineNumbers: true,
    }, ctx);
    expect(result.summary).toBe("     2|beta");
    expect(result.details?.[READ_COVERAGE_DETAIL_KEY]).toMatchObject({
      startLine: 2, endLine: 2, totalLines: 3, numbered: true,
    });
  });

  it("shares extension normalization with list filtering and rendered totals", async () => {
    await writeFile(join(workingDir, "a[1].PDF"), "one");
    await writeFile(join(workingDir, "b.txt"), "two");
    const parsed = parseListArgs({ path: ".", pattern: "a[?].*", extensions: [".PDF", 8, ""] });
    expect(parsed.extensions).toEqual(["pdf"]);
    expect(parsed.patternRegex?.test("a[1].PDF")).toBe(true);
    expect(parsed.patternRegex?.test("ab1.PDF")).toBe(false);
    expect(normaliseExt(".PDF")).toBe("pdf");
    const result = await osFsListTool.run({ path: ".", extensions: [".PDF"] }, ctx);
    expect(result.details).toMatchObject({ total: 2, matched: 1, shown: 1, filter: { extensions: ["pdf"] } });
    expect(result.summary).toContain("pdf=1");
    expect(result.summary).toContain("a[1].PDF");
  });

  it("keeps permissive list fallback semantics distinct from the advertised enum", () => {
    expect(parseListArgs({ path: ".", kind: "other", sort: "unsupported", extensions: [] })).toMatchObject({
      kind: null, sort: "name", extensions: null, maxEntries: 200,
    });
    expect(OS_FS_LIST_CONTRACT.argsJsonSchema.properties.kind.enum).toEqual(["file", "dir"]);
    expect(OS_FS_LIST_CONTRACT.argsJsonSchema.properties.sort.enum).toEqual(["name", "size", "mtime"]);
  });

  it("calls the supplied basename only at old label fallback positions", () => {
    const calls: string[] = [];
    const args = parseDiffArgs({
      aPath: "nested/a.txt", bPath: "nested/b.txt", aLabel: "explicit",
      get bLabel() { calls.push("bLabel"); return undefined; },
      get context() { calls.push("context"); return 0; },
    }, (path) => { calls.push(`basename:${path}`); return basename(path); });
    expect(args).toMatchObject({ aLabel: "explicit", bLabel: "b.txt", context: 0 });
    expect(calls).toEqual(["bLabel", "basename:nested/b.txt", "context"]);
    expect(() => parseDiffArgs({ aPath: "a.txt", aText: "inline", bText: "b" }, () => {
      throw new Error("label fallback must not run");
    })).toThrow("os.fs.diff: side a must not set both `aPath` and `aText`");
  });

  it("preserves actual file diff headers and inline empty-side behavior", async () => {
    await writeFile(join(workingDir, "before.txt"), "old\n");
    await writeFile(join(workingDir, "after.txt"), "new\n");
    const result = await osFsDiffTool.run({ aPath: "before.txt", bPath: "after.txt", context: 0 }, ctx);
    expect(result.details).toMatchObject({ aLabel: "before.txt", bLabel: "after.txt", added: 1, removed: 1 });
    expect(result.summary).toContain("--- before.txt");
    expect(result.summary).toContain("+++ after.txt");
    const empty = await osFsDiffTool.run({ aText: "", bText: "" }, ctx);
    expect(empty.details?.identical).toBe(true);
  });

  it("allows edit deletion and keeps unchanged-string validation ahead of filesystem work", async () => {
    expect(parseEditArgs({ path: "data.txt", oldString: "old", newString: "" }).newString).toBe("");
    expect(() => parseEditArgs({ path: "data.txt", oldString: "same", newString: "same" })).toThrow(
      "os.fs.edit: `newString` must differ from `oldString`",
    );
    await writeFile(join(workingDir, "data.txt"), "old tail\n");
    const result = await editTool.run({ path: "data.txt", oldString: "old", newString: "" }, ctx);
    expect(result.status).toBe("ok");
    expect(await readFile(join(workingDir, "data.txt"), "utf8")).toBe(" tail\n");
    await expect(editTool.run({ path: "missing.txt", oldString: "same", newString: "same" }, ctx)).rejects.toThrow(
      "os.fs.edit: `newString` must differ from `oldString`",
    );
  });
});
