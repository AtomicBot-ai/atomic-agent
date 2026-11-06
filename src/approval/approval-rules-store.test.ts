import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalRulesStore,
  getApprovalRulesPath,
  getProjectApprovalRulesPath,
} from "./approval-rules-store.js";

describe("ApprovalRulesStore", () => {
  let stateDir: string;
  let projectDir: string;
  let warnings: string[];
  let ids: number;

  function open(): ApprovalRulesStore {
    return new ApprovalRulesStore({
      stateDir,
      warn: (message) => warnings.push(message),
      now: () => new Date("2026-11-06T10:00:00Z"),
      newId: () => `r_${String(++ids).padStart(8, "0")}`,
    });
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "approval-rules-state-"));
    projectDir = mkdtempSync(join(tmpdir(), "approval-rules-project-"));
    warnings = [];
    ids = 0;
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("treats a missing file as no rules", () => {
    expect(open().list()).toEqual([]);
    expect(open().projectRules(projectDir)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("treats a corrupt file as no rules, logs it, and never throws", () => {
    writeFileSync(getApprovalRulesPath(stateDir), "{not json");
    const store = open();
    expect(store.list()).toEqual([]);
    expect(warnings.join("\n")).toMatch(/not valid JSON/);
    writeFileSync(getApprovalRulesPath(stateDir), JSON.stringify({ rules: "nope" }));
    expect(store.list()).toEqual([]);
    expect(warnings.join("\n")).toMatch(/ignored/);
  });

  it("adds a rule to the global file, owner-only, written whole", () => {
    const store = open();
    const rule = store.add({
      decision: "allow",
      tool: "os.shell.run",
      category: "shell",
      commandPrefix: ["git", "status"],
      project: projectDir,
      source: "prompt",
    });
    expect(rule).toMatchObject({
      id: "r_00000001",
      createdAt: "2026-11-06T10:00:00.000Z",
      project: realpathSync(projectDir),
    });
    const path = getApprovalRulesPath(stateDir);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { version: number; rules: unknown[] };
    expect(onDisk.version).toBe(1);
    expect(onDisk.rules).toHaveLength(1);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    // No tmp file left beside it.
    expect(readdirSync(stateDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(open().list()).toEqual([rule]);
  });

  it("returns the existing rule instead of saving the same one twice", () => {
    const store = open();
    const input = {
      decision: "allow" as const,
      tool: "os.shell.run",
      category: "shell" as const,
      commandPrefix: ["npm", "test"],
      project: projectDir,
      source: "prompt" as const,
    };
    const first = store.add(input);
    expect(store.add(input)).toEqual(first);
    expect(store.list()).toHaveLength(1);
  });

  it("removes a rule by id", () => {
    const store = open();
    const rule = store.add({ decision: "deny", commandPrefix: ["rm"], source: "user" });
    expect(store.remove("r_missing")).toBe(false);
    expect(store.remove(rule.id)).toBe(true);
    expect(store.list()).toEqual([]);
  });

  it("picks up a change another process wrote", () => {
    const store = open();
    expect(store.list()).toEqual([]);
    writeFileSync(
      getApprovalRulesPath(stateDir),
      JSON.stringify({ version: 1, rules: [{ id: "r_desk", decision: "deny", commandPrefix: ["curl"] }] }),
    );
    expect(store.list().map((r) => r.id)).toEqual(["r_desk"]);
  });

  it("moves an unreadable file aside before saving over it", () => {
    const path = getApprovalRulesPath(stateDir);
    writeFileSync(path, "{hand edit gone wrong");
    const store = open();
    store.add({ decision: "deny", commandPrefix: ["rm"], source: "user" });
    const aside = readdirSync(stateDir).filter((f) => f.startsWith("approval-rules.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(stateDir, aside[0]!), "utf8")).toBe("{hand edit gone wrong");
    expect(store.list()).toHaveLength(1);
  });

  it("honours only ask and deny from a project's own file", () => {
    const path = getProjectApprovalRulesPath(projectDir);
    mkdirSync(join(projectDir, ".atomic-agent"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rules: [
          // What a model with write access to the workspace would add.
          { id: "r_self", decision: "allow", category: "shell" },
          { id: "r_push", decision: "ask", commandPrefix: ["git", "push"] },
        ],
      }),
    );
    const store = open();
    expect(store.projectRules(projectDir).map((r) => r.id)).toEqual(["r_push"]);
    expect(warnings.join("\n")).toMatch(/cannot allow/);
    // And it never lands in the global file.
    expect(existsSync(getApprovalRulesPath(stateDir))).toBe(false);
  });
});
