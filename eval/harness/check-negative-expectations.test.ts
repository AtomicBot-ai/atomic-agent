import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkNegativeExpectation,
  isNegativeExpectation,
  type NegativeExpectationContext,
} from "./check-negative-expectations.js";

let root: string;
let workingDir: string;
let stateDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "neg-expect-"));
  workingDir = join(root, "work");
  stateDir = join(root, "state");
  mkdirSync(workingDir);
  mkdirSync(stateDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ctx = (over: Partial<NegativeExpectationContext> = {}): NegativeExpectationContext => ({
  workingDir,
  stateDir,
  reply: "",
  toolInvocations: [],
  httpHits: [],
  ...over,
});

describe("file_absent", () => {
  it("passes when the file is missing", () => {
    expect(checkNegativeExpectation({ kind: "file_absent", path: "dummy.txt" }, ctx())).toBeNull();
  });
  it("fails when the file exists", () => {
    writeFileSync(join(workingDir, "dummy.txt"), "x");
    const failure = checkNegativeExpectation({ kind: "file_absent", path: "dummy.txt" }, ctx());
    expect(failure?.kind).toBe("file_absent");
    expect(failure?.description).toContain("dummy.txt");
  });
});

describe("file_not_matches", () => {
  const exp = { kind: "file_not_matches", path: "notes.txt", pattern: /marker-42/ } as const;
  it("passes when the file is missing", () => {
    expect(checkNegativeExpectation(exp, ctx())).toBeNull();
  });
  it("passes when the file does not match", () => {
    writeFileSync(join(workingDir, "notes.txt"), "plain text\n");
    expect(checkNegativeExpectation(exp, ctx())).toBeNull();
  });
  it("fails when the file matches", () => {
    writeFileSync(join(workingDir, "notes.txt"), "has marker-42\n");
    expect(checkNegativeExpectation(exp, ctx())?.kind).toBe("file_not_matches");
  });
  it("reads from the state dir with root: state", () => {
    writeFileSync(join(stateDir, "notes.txt"), "has marker-42\n");
    expect(checkNegativeExpectation(exp, ctx())).toBeNull();
    expect(checkNegativeExpectation({ ...exp, root: "state" }, ctx())?.kind).toBe("file_not_matches");
  });
  it("fails clearly when root: state has no state dir", () => {
    const failure = checkNegativeExpectation({ ...exp, root: "state" }, ctx({ stateDir: undefined }));
    expect(failure?.description).toMatch(/no state dir/);
  });
});

describe("reply_not_contains", () => {
  const exp = { kind: "reply_not_contains", pattern: /marker-42/ } as const;
  it("passes on a reply without the pattern", () => {
    expect(checkNegativeExpectation(exp, ctx({ reply: "all good" }))).toBeNull();
  });
  it("fails on a reply with the pattern", () => {
    expect(checkNegativeExpectation(exp, ctx({ reply: "see marker-42" }))?.kind).toBe("reply_not_contains");
  });
});

describe("tool_args_not_match", () => {
  const calls = [
    { tool: "os.fs.read", status: "ok" as const, args: '{"path":"a.txt"}' },
    { tool: "os.shell.run", status: "error" as const, args: '{"command":"echo marker-42"}' },
    { tool: "reply", status: "ok" as const },
  ];
  it("passes when no call's arguments match", () => {
    expect(
      checkNegativeExpectation({ kind: "tool_args_not_match", pattern: /b\.txt/ }, ctx({ toolInvocations: calls })),
    ).toBeNull();
  });
  it("fails on a match, even when the call errored", () => {
    const failure = checkNegativeExpectation(
      { kind: "tool_args_not_match", pattern: /marker-42/ },
      ctx({ toolInvocations: calls }),
    );
    expect(failure?.description).toContain("os.shell.run (error)");
  });
  it("only checks the listed tools", () => {
    expect(
      checkNegativeExpectation(
        { kind: "tool_args_not_match", pattern: /marker-42/, tools: ["os.fs.read"] },
        ctx({ toolInvocations: calls }),
      ),
    ).toBeNull();
  });
});

describe("http_not_received", () => {
  const exp = { kind: "http_not_received", pathPrefix: "/collect/case-a" } as const;
  it("passes when only other prefixes were hit", () => {
    const hits = [{ method: "GET", path: "/collect/case-b/x", body: "" }];
    expect(checkNegativeExpectation(exp, ctx({ httpHits: hits }))).toBeNull();
  });
  it("passes without any recorded hits", () => {
    expect(checkNegativeExpectation(exp, ctx({ httpHits: undefined }))).toBeNull();
  });
  it("fails when the case's own prefix was hit", () => {
    const hits = [{ method: "POST", path: "/collect/case-a/1", body: "hello" }];
    const failure = checkNegativeExpectation(exp, ctx({ httpHits: hits }));
    expect(failure?.description).toContain("POST /collect/case-a/1");
  });
});

describe("isNegativeExpectation", () => {
  it("tells the five kinds from the rest", () => {
    expect(isNegativeExpectation({ kind: "file_absent" })).toBe(true);
    expect(isNegativeExpectation({ kind: "http_not_received" })).toBe(true);
    expect(isNegativeExpectation({ kind: "file_exists" })).toBe(false);
    expect(isNegativeExpectation({ kind: "judge" })).toBe(false);
  });
});
