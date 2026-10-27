import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { compressToolResult } from "../../../compressor/result-compressor.js";
import { describeArgumentError } from "../../argument-error-hint.js";
import { ToolRegistry, type ToolContext } from "../../tool-registry.js";
import { findUnknownArguments } from "../../unknown-argument-guard.js";
import { buildOsFsMoveTool } from "./fs-move.js";
import { readMoveAliases } from "./fs-move-aliases.js";

const HINT = "os.fs.move takes { from, to } or { moves: [{ from, to }] }";

describe("readMoveAliases", () => {
  it("reads the live ATO-899 call — one path and a full target path — as from/to", () => {
    const reading = readMoveAliases({
      paths: ["archive (4).zip"],
      destination: "Archives/archive (4).zip",
    });
    expect(reading).toEqual({
      args: { from: "archive (4).zip", to: "Archives/archive (4).zip" },
      note: `note: read \`paths\` as \`from\` and \`destination\` as \`to\`; ${HINT}`,
    });
  });

  it("reads a one-entry list with a folder-like destination as a move INTO that folder", () => {
    // Not a rename of a.zip to an extensionless file called `Archives`:
    // two paths mean "into the folder", so one path does too.
    expect(readMoveAliases({ paths: ["a.zip"], destination: "Archives" }, { platform: "linux" })).toEqual({
      args: { from: "a.zip", to: "Archives/" },
      note: `note: read \`paths\` as \`from\` and \`destination\` as the folder \`to\`: \`Archives/\`; ${HINT}`,
    });
    expect(readMoveAliases({ sources: ["a.zip"], target: "Out/" }, { platform: "linux" })!.args.to).toBe("Out/");
  });

  it("keeps a one-entry list's destination as the target path when it reads as a file", () => {
    const linux = { platform: "linux" as const };
    // An extension in the last segment.
    expect(readMoveAliases({ paths: ["a.zip"], destination: "Archives/b.zip" }, linux)!.args.to).toBe("Archives/b.zip");
    // The source's own name repeated.
    expect(readMoveAliases({ paths: ["dir/README"], destination: "Docs/README" }, linux)!.args.to).toBe("Docs/README");
    // An existing file (the registry's probe).
    expect(
      readMoveAliases({ paths: ["a"], destination: "Makefile" }, { ...linux, isFile: (p) => p === "Makefile" })!.args.to,
    ).toBe("Makefile");
    // A leading dot alone is a hidden name, not an extension.
    expect(readMoveAliases({ paths: ["a"], destination: ".cache" }, linux)!.args.to).toBe(".cache/");
  });

  it("keeps the tool's own `to` rule for a string source alias", () => {
    expect(readMoveAliases({ src: "a.zip", dest: "Archives" })!.args).toEqual({ from: "a.zip", to: "Archives" });
    expect(readMoveAliases({ source: ["a.zip"], target: "Archives" })!.args).toEqual({ from: "a.zip", to: "Archives" });
  });

  it("reads a list that arrived as a JSON string", () => {
    expect(
      readMoveAliases({ paths: '["a.zip","b.zip"]', destination: "Archives" }, { platform: "linux" })!.args.moves,
    ).toEqual([
      { from: "a.zip", to: "Archives/" },
      { from: "b.zip", to: "Archives/" },
    ]);
    // Only a real JSON list: a name in brackets stays a path.
    expect(readMoveAliases({ src: "[draft].txt", dest: "x.txt" })!.args.from).toBe("[draft].txt");
    expect(readMoveAliases({ src: "[a]", dest: "x.txt" })!.args.from).toBe("[a]");
  });

  it("reads several paths and one destination as moves into that folder", () => {
    const reading = readMoveAliases(
      { paths: ["a.zip", "b.zip"], destination: "Archives", overwrite: true },
      { platform: "linux" },
    );
    expect(reading).toEqual({
      args: {
        overwrite: true,
        moves: [
          { from: "a.zip", to: "Archives/" },
          { from: "b.zip", to: "Archives/" },
        ],
      },
      note: `note: read \`paths\` (2 paths) and \`destination\` as moves into \`Archives/\`; ${HINT}`,
    });
  });

  it("does not add a second separator to a destination that already names a folder", () => {
    expect(readMoveAliases({ sources: ["a", "b"], target: "Out/" }, { platform: "linux" })!.args.moves).toEqual([
      { from: "a", to: "Out/" },
      { from: "b", to: "Out/" },
    ]);
    expect(readMoveAliases({ sources: ["a", "b"], target: "Out\\" }, { platform: "win32" })!.args.moves).toEqual([
      { from: "a", to: "Out\\" },
      { from: "b", to: "Out\\" },
    ]);
    // A Windows drive path without a trailing separator gets `/`, which
    // the tool reads as a separator on every platform.
    expect(readMoveAliases({ paths: ["a", "b"], destination: "C:\\Out" }, { platform: "win32" })!.args.moves).toEqual([
      { from: "a", to: "C:\\Out/" },
      { from: "b", to: "C:\\Out/" },
    ]);
  });

  it("reads src/dest and source/dest with a string source", () => {
    expect(readMoveAliases({ src: "old.txt", dest: "new.txt" })).toEqual({
      args: { from: "old.txt", to: "new.txt" },
      note: `note: read \`src\` as \`from\` and \`dest\` as \`to\`; ${HINT}`,
    });
    expect(readMoveAliases({ source: "a", target: "b" })!.args).toEqual({ from: "a", to: "b" });
  });

  it("never reads an alias beside a canonical key", () => {
    expect(readMoveAliases({ from: "a", paths: ["b"], destination: "c" })).toBeNull();
    expect(readMoveAliases({ to: "x", src: "a", dest: "b" })).toBeNull();
    expect(readMoveAliases({ moves: [{ from: "a", to: "b" }], src: "c", dest: "d" })).toBeNull();
    // A strict provider's empty filler is not a canonical key.
    expect(readMoveAliases({ src: "a", dest: "b", from: null, moves: [] })!.args).toEqual({ from: "a", to: "b" });
  });

  it("reads nothing that is ambiguous or incomplete", () => {
    expect(readMoveAliases({ from: "a", to: "b" })).toBeNull();
    expect(readMoveAliases({ paths: ["a"] })).toBeNull();
    expect(readMoveAliases({ destination: "b" })).toBeNull();
    expect(readMoveAliases({ src: "a", source: "b", dest: "c" })).toBeNull();
    expect(readMoveAliases({ src: "a", dest: "c", target: "d" })).toBeNull();
    expect(readMoveAliases({ paths: [], destination: "c" })).toBeNull();
    expect(readMoveAliases({ paths: ["a", 3], destination: "c" })).toBeNull();
    expect(readMoveAliases({ paths: ["a"], destination: "" })).toBeNull();
  });

  it("passes other keys through, so an unknown one is still there to refuse", () => {
    expect(readMoveAliases({ src: "a", dest: "b", recursive: true })!.args).toEqual({
      recursive: true,
      from: "a",
      to: "b",
    });
  });
});

describe("os.fs.move aliases at the unknown-argument guard", () => {
  it("does not refuse paths/destination or src/dest", () => {
    expect(
      findUnknownArguments("os.fs.move", { paths: ["a.zip", "b.zip"], destination: "Archives" }),
    ).toBeNull();
    expect(findUnknownArguments("os.fs.move", { src: "a", dest: "b" })).toBeNull();
  });

  it("still refuses an alias given beside a canonical key", () => {
    const report = findUnknownArguments("os.fs.move", { from: "a", to: "b", destination: "c" });
    expect(report!.unknownKeys).toEqual(["destination"]);
    expect(findUnknownArguments("os.fs.move", { from: "a", paths: ["b"], destination: "c" })!.unknownKeys)
      .toEqual(["paths", "destination"]);
  });

  it("still refuses an unknown key that is not an alias, aliased call or not", () => {
    expect(findUnknownArguments("os.fs.move", { src: "a", dest: "b", recursive: true })!.unknownKeys)
      .toEqual(["recursive"]);
    expect(findUnknownArguments("os.fs.move", { from: "a", to: "b", recursive: true })!.unknownKeys)
      .toEqual(["recursive"]);
  });
});

describe("os.fs.move aliases in the argument-error hint", () => {
  it("does not call an aliased call's keys wrong", () => {
    expect(
      describeArgumentError({
        tool: "os.fs.move",
        args: { src: "a.txt", dest: "b.txt" },
        message: "os.fs.move: nothing at `a.txt`",
      }),
    ).toBeNull();
    // An unknown key beside the aliases is still reported.
    expect(
      describeArgumentError({
        tool: "os.fs.move",
        args: { src: "a.txt", dest: "b.txt", recursive: true },
        message: "os.fs.move: nothing at `a.txt`",
      })!.message,
    ).toContain("received keys: recursive, from, to");
  });
});

describe("os.fs.move aliases through the registry", () => {
  let dir: string;
  let gate: ApprovalGate;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-move-alias-"));
    gate = new ApprovalGate({
      level: 1,
      emit: (request) => {
        queueMicrotask(() => gate.resolve({ approvalId: request.approvalId, approved: true }));
      },
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({
    workingDir: dir,
    sessionId: "s-move-alias",
    stepIndex: 0,
    signal: new AbortController().signal,
  });

  function registry(): ToolRegistry {
    const reg = new ToolRegistry();
    reg.register(buildOsFsMoveTool({ approvals: gate, approvalRequired: true }));
    return reg;
  }

  async function put(rel: string): Promise<void> {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), rel);
  }

  it("moves one file by paths/destination and says how the call was read", async () => {
    await put("archive (4).zip");
    const result = await registry().invoke(
      "os.fs.move",
      { paths: ["archive (4).zip"], destination: "Archives/archive (4).zip" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(existsSync(join(dir, "Archives/archive (4).zip"))).toBe(true);
    // Last line, so the first stays the outcome the tool log and
    // compaction quote.
    const lines = result.summary.split("\n");
    expect(lines.at(-1)).toBe(`note: read \`paths\` as \`from\` and \`destination\` as \`to\`; ${HINT}`);
    expect(lines[0]).not.toMatch(/^note:/);
  });

  it("moves several files into a folder that does not exist yet", async () => {
    await put("a.zip");
    await put("b.zip");
    const result = await registry().invoke(
      "os.fs.move",
      { paths: ["a.zip", "b.zip"], destination: "Archives" },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(existsSync(join(dir, "Archives/a.zip"))).toBe(true);
    expect(existsSync(join(dir, "Archives/b.zip"))).toBe(true);
    expect(result.summary).toContain("as moves into `Archives/`");
  });

  it("hands every wrapper the canonical keys, and keeps a canonical call untouched", async () => {
    const seen: Record<string, unknown>[] = [];
    const reg = new ToolRegistry();
    reg.register({
      name: "os.fs.move",
      description: "stub",
      readonly: false,
      async run(args) {
        seen.push(args);
        return compressToolResult({ tool: "os.fs.move", status: "ok", output: "done" });
      },
    });
    await reg.invoke("os.fs.move", { src: "a", dest: "b" }, ctx());
    const plain = await reg.invoke("os.fs.move", { from: "a", to: "b" }, ctx());
    expect(seen).toEqual([{ from: "a", to: "b" }, { from: "a", to: "b" }]);
    expect(plain.summary).toBe("done");
  });

  it("moves one listed file into a folder that does not exist yet", async () => {
    await put("a.zip");
    const result = await registry().invoke("os.fs.move", { paths: ["a.zip"], destination: "Archives" }, ctx());
    expect(result.status).toBe("ok");
    expect(existsSync(join(dir, "Archives/a.zip"))).toBe(true);
  });

  it("keeps an existing extensionless file as the target (overwrite asked for)", async () => {
    await put("a");
    await put("Makefile");
    const result = await registry().invoke(
      "os.fs.move",
      { paths: ["a"], destination: "Makefile", overwrite: true },
      ctx(),
    );
    expect(result.status).toBe("ok");
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(existsSync(join(dir, "Makefile"))).toBe(true);
  });

  it("rethrows an error whose message cannot be set, unchanged", async () => {
    // Getter-only, like a DOMException's: assigning to it throws in strict mode.
    const thrown = new Error("frozen");
    Object.defineProperty(thrown, "message", { get: () => "frozen" });
    const reg = new ToolRegistry();
    reg.register({
      name: "os.fs.move",
      description: "stub",
      readonly: false,
      run: async () => {
        throw thrown;
      },
    });
    await expect(reg.invoke("os.fs.move", { src: "a", dest: "b" }, ctx())).rejects.toBe(thrown);
  });

  it("puts the note on an error the aliased call ends in", async () => {
    await expect(
      registry().invoke("os.fs.move", { src: "missing.txt", dest: "x.txt" }, ctx()),
    ).rejects.toThrow(/note: read `src` as `from` and `dest` as `to`/);
  });
});
