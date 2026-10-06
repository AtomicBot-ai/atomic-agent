import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import type { FsDangerousToolOptions } from "./fs-require-approval.js";
import type { FileRestoreStore } from "./fs-restore-store.js";
import { OS_FS_GLOB_CONTRACT } from "./fs-glob-contract.js";
import { OS_FS_GREP_CONTRACT } from "./fs-grep-contract.js";
import { OS_FS_WATCH_CONTRACT } from "./fs-watch-contract.js";
import { OS_FS_WRITE_CONTRACT, parseWriteArgs } from "./fs-write-contract.js";
import { OS_FS_PATCH_CONTRACT } from "./fs-patch-contract.js";
import { OS_FS_TRASH_CONTRACT, parseTrashArgs } from "./fs-trash-contract.js";
import { OS_FS_RESTORE_CONTRACT, parseRestoreArgs } from "./fs-restore-contract.js";
import { OS_FS_LOCATE_PROJECT_CONTRACT } from "./fs-locate-project-contract.js";
import { osFsGlobTool } from "./fs-glob.js";
import { buildOsFsGrepTool } from "./fs-grep.js";
import { osFsWatchTool } from "./fs-watch.js";
import { buildOsFsWriteTool } from "./fs-write.js";
import { buildOsFsPatchTool } from "./fs-patch.js";
import { buildOsFsTrashTool } from "./fs-trash.js";
import { buildOsFsRestoreTool } from "./fs-restore.js";
import { buildOsFsLocateProjectTool } from "./fs-locate-project.js";

function unusedApproval(): FsDangerousToolOptions {
  return {
    approvals: new ApprovalGate({ emit: () => { throw new Error("unexpected approval"); } }),
    approvalRequired: true,
  };
}

function context(workingDir: string): ToolContext {
  return { workingDir, sessionId: "contract-test", stepIndex: 0, signal: new AbortController().signal };
}

const projections = [
  [OS_FS_GLOB_CONTRACT, osFsGlobTool],
  [OS_FS_GREP_CONTRACT, buildOsFsGrepTool()],
  [OS_FS_WATCH_CONTRACT, osFsWatchTool],
  [OS_FS_WRITE_CONTRACT, buildOsFsWriteTool(unusedApproval())],
  [OS_FS_PATCH_CONTRACT, buildOsFsPatchTool(unusedApproval())],
  [OS_FS_TRASH_CONTRACT, buildOsFsTrashTool(unusedApproval())],
  [OS_FS_RESTORE_CONTRACT, buildOsFsRestoreTool(unusedApproval())],
  [OS_FS_LOCATE_PROJECT_CONTRACT, buildOsFsLocateProjectTool({ listRecentSessions: () => [], projectRoots: [] })],
] as const;

describe("filesystem operation metadata projections", () => {
  it.each(projections)("%s execution uses its canonical definition facets", (contract, definition) => {
    expect({ name: definition.name, description: definition.description, readonly: definition.readonly })
      .toEqual({ name: contract.name, description: contract.description, readonly: contract.readonly });
    expect(contract.descriptor.name).toBe(contract.name);
  });
});

describe("pure write/trash/restore argument seams", () => {
  it("write eagerly reads both required fields before rejecting path", () => {
    const events: string[] = [];
    expect(() => parseWriteArgs({
      get path() { events.push("path"); return ""; },
      get content() { events.push("content"); return 1; },
      get mode() { throw new Error("mode must remain unread"); },
    })).toThrow("os.fs.write: `path` must be a non-empty string");
    expect(events).toEqual(["path", "content"]);
  });

  it("an eager content getter error precedes invalid path validation", () => {
    const failure = new Error("content getter");
    expect(() => parseWriteArgs({ path: "", get content() { throw failure; } })).toThrow(failure);
  });

  it("write retains two mode reads and exact overwrite boolean semantics", () => {
    let reads = 0;
    const result = parseWriteArgs({
      path: "a", content: "", get mode() { return ++reads === 1 ? "replace" : "append"; }, overwrite: true,
    });
    expect(result).toEqual({ path: "a", content: "", mode: "append", overwrite: true });
    expect(reads).toBe(2);
    expect(parseWriteArgs({ path: "a", content: "", mode: "APPEND", overwrite: 1 }))
      .toEqual({ path: "a", content: "", mode: "replace", overwrite: false });
  });

  it("write rejects invalid content before reading optional fields", () => {
    expect(() => parseWriteArgs({ path: "a", content: null, get overwrite() { throw new Error("late getter"); } }))
      .toThrow("os.fs.write: `content` must be a string");
  });

  it("trash preserves runtime coercion wider than the advertised string array", () => {
    const source = [0, null, false, { toString: () => "object-path" }];
    const first = parseTrashArgs({ paths: source });
    const second = parseTrashArgs({ paths: source });
    expect(first).toEqual({ paths: ["0", "null", "false", "object-path"] });
    expect(second.paths).not.toBe(first.paths);
    expect(first.paths).not.toBe(source);
    expect(OS_FS_TRASH_CONTRACT.argsJsonSchema.properties.paths.items.type).toBe("string");
  });

  it("trash applies its size guard before any element conversion", () => {
    let conversions = 0;
    const value = { toString() { conversions++; return "a"; } };
    expect(() => parseTrashArgs({ paths: Array.from({ length: 501 }, () => value) }))
      .toThrow("os.fs.trash: at most 500 paths per call (got 501)");
    expect(conversions).toBe(0);
    expect(parseTrashArgs({ paths: Array.from({ length: 500 }, () => "a") }).paths).toHaveLength(500);
  });

  it("trash converts every item before checking an empty converted path", () => {
    const events: string[] = [];
    expect(() => parseTrashArgs({ paths: ["", { toString() { events.push("converted"); return "a"; } }] }))
      .toThrow("os.fs.trash: each path must be a non-empty string");
    expect(events).toEqual(["converted"]);
  });

  it("trash keeps sparse-array failure rather than filling absent entries", () => {
    expect(() => parseTrashArgs({ paths: new Array(1) })).toThrow(TypeError);
    expect(() => parseTrashArgs({ paths: [] })).toThrow("os.fs.trash: `paths` must be a non-empty array of strings");
  });

  it("restore leaves path resolution with execution", () => {
    const raw = { path: "~/relative" };
    expect(parseRestoreArgs(raw)).toEqual(raw);
    expect(parseRestoreArgs(raw)).not.toBe(raw);
    expect(() => parseRestoreArgs({ path: "" })).toThrow("os.fs.restore: `path` must be a non-empty string");
  });
});

describe("execution ordering across filesystem effects", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "atomic-fs-contracts-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("write argument failure occurs before restore/input/approval dependencies", async () => {
    const options: FsDangerousToolOptions = {
      ...unusedApproval(), get restore(): FileRestoreStore | undefined { throw new Error("restore must remain unread"); },
    };
    await expect(buildOsFsWriteTool(options).run({ path: "a", content: 1 }, context(dir)))
      .rejects.toThrow("os.fs.write: `content` must be a string");
  });

  it("restore validates path before consulting the injected store", async () => {
    let reads = 0;
    const options: FsDangerousToolOptions = {
      ...unusedApproval(), get restore() { reads++; return undefined; },
    };
    const tool = buildOsFsRestoreTool(options);
    await expect(tool.run({ path: "" }, context(dir))).rejects.toThrow("os.fs.restore: `path` must be a non-empty string");
    expect(reads).toBe(0);
    await expect(tool.run({ path: "a" }, context(dir)))
      .rejects.toThrow("os.fs.restore: this runtime keeps no restore copies (no state directory)");
    expect(reads).toBe(1);
  });

  it("trash reaches denied approval before missing-path IO or native dispatch", async () => {
    const gate = new ApprovalGate({ level: 1, emit: request => gate.reject(request.approvalId, "fixture denied") });
    await expect(buildOsFsTrashTool({ approvals: gate, approvalRequired: true })
      .run({ paths: [join(dir, "missing")] }, context(dir))).rejects.toThrow("fixture denied");
  });

  it("watch missing-path error wins over every late argument getter", async () => {
    const raw = {
      path: "missing",
      get timeoutMs() { throw new Error("timeout must remain unread"); },
      get recursive() { throw new Error("recursive must remain unread"); },
    };
    await expect(osFsWatchTool.run(raw, context(dir)))
      .rejects.toThrow(`os.fs.watch: path does not exist: ${join(dir, "missing")}`);
  });

  it("watch reads timeout only after awaited stat and stops before remaining options", async () => {
    const events: string[] = [];
    const pending = osFsWatchTool.run({
      get path() { events.push("path"); return "."; },
      get timeoutMs() { events.push("timeout"); return -1; },
      get recursive() { throw new Error("recursive must remain unread"); },
    }, context(dir));
    expect(events).toEqual(["path"]);
    await expect(pending).rejects.toThrow("os.fs.watch: `timeoutMs` must be a positive number");
    expect(events).toEqual(["path", "timeout"]);
  });

  it("patch reads both sources even when inline patch wins", async () => {
    const events: string[] = [];
    await expect(buildOsFsPatchTool(unusedApproval()).run({
      get patch() { events.push("patch"); return "inline source"; },
      get patchPath() { events.push("patchPath"); return join(dir, "missing"); },
      get apply() { events.push("apply"); return false; },
      get fuzzFactor() { events.push("fuzzFactor"); return -1; },
      get stripComponents() { throw new Error("stripComponents must remain unread"); },
    }, context(dir))).rejects.toThrow("os.fs.patch: `fuzzFactor` must be a non-negative number");
    expect(events).toEqual(["patch", "patchPath", "apply", "fuzzFactor"]);
  });

  it("patchPath getter errors precede choosing a valid inline source", async () => {
    const failure = new Error("patchPath getter");
    await expect(buildOsFsPatchTool(unusedApproval()).run({
      patch: "inline source", get patchPath() { throw failure; },
      get apply() { throw new Error("apply must remain unread"); },
    }, context(dir))).rejects.toThrow(failure);
  });

  it("patch file IO failure precedes late option getter errors", async () => {
    const events: string[] = [];
    const pending = buildOsFsPatchTool(unusedApproval()).run({
      get patch() { events.push("patch"); return ""; },
      get patchPath() { events.push("patchPath"); return "missing.diff"; },
      get apply() { throw new Error("apply must remain unread"); },
      get rootDir() { throw new Error("rootDir must remain unread"); },
      get fuzzFactor() { throw new Error("fuzzFactor must remain unread"); },
    }, context(dir));
    expect(events).toEqual(["patch", "patchPath"]);
    await expect(pending).rejects.toThrow("ENOENT");
    expect(events).toEqual(["patch", "patchPath"]);
  });

  it("patch reads late options in order after awaited file content", async () => {
    await writeFile(join(dir, "source.diff"), "not parsed before option validation", "utf8");
    const events: string[] = [];
    const pending = buildOsFsPatchTool(unusedApproval()).run({
      get patch() { events.push("patch"); return null; },
      get patchPath() { events.push("patchPath"); return "source.diff"; },
      get apply() { events.push("apply"); return true; },
      get rootDir() { events.push("rootDir"); return "."; },
      get fuzzFactor() { events.push("fuzzFactor"); return -1; },
      get stripComponents() { throw new Error("stripComponents must remain unread"); },
    }, context(dir));
    expect(events).toEqual(["patch", "patchPath"]);
    await expect(pending).rejects.toThrow("os.fs.patch: `fuzzFactor` must be a non-negative number");
    expect(events).toEqual(["patch", "patchPath", "apply", "rootDir", "fuzzFactor"]);
    expect(await readFile(join(dir, "source.diff"), "utf8")).toBe("not parsed before option validation");
  });
});
