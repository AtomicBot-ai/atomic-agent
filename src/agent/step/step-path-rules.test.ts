import { describe, expect, it } from "vitest";
import { emitAttachedPathRules } from "./step-path-rules.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../../session/conversation-turn.js";
import type { PathRule, SessionWorkspace } from "../../session/workspace-context.js";
import type { StepEvent } from "../step-events.js";

const sqlRule: PathRule = { path: ".atomic-agent/rules/sql.md", patterns: ["*.sql"], body: "SQL RULE" };
const call = (tool: string, args: Record<string, unknown>, at: number) => assistantToolCallTurn({ tool, args, at });

describe("emitAttachedPathRules (ATO-2443)", () => {
  const before = [userTurn("go", 1)];
  const after = [...before, call("os.fs.read", { path: "db/a.sql" }, 2), toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "x", at: 3 })];

  it("names a local rule once, on the step that matched it", () => {
    const events: StepEvent[] = [];
    const ctx = { localPathRules: [sqlRule], stepIndex: 4 };
    emitAttachedPathRules(ctx, "/work", before, after, e => events.push(e));
    expect(events).toEqual([{ type: "path_rule_attached", path: sqlRule.path, patterns: ["*.sql"], stepIndex: 4 }]);
    const later = [...after, call("os.fs.read", { path: "db/b.sql" }, 4)];
    emitAttachedPathRules(ctx, "/work", after, later, e => events.push(e));
    expect(events).toHaveLength(1);
  });

  it("reads a cloud step's rules from its workspace", () => {
    const events: StepEvent[] = [];
    const workspace = { workingDir: "/work", cloud: true, pathRules: [sqlRule] } as unknown as SessionWorkspace;
    emitAttachedPathRules({ workspace, stepIndex: 1 }, "/work", before, after, e => events.push(e));
    expect(events.map(e => e.type)).toEqual(["path_rule_attached"]);
  });

  it("stays quiet without rules, without a match or without a listener", () => {
    const events: StepEvent[] = [];
    emitAttachedPathRules({ stepIndex: 1 }, "/work", before, after, e => events.push(e));
    emitAttachedPathRules({ localPathRules: [sqlRule], stepIndex: 1 }, "/work", before, [...before, call("os.fs.read", { path: "a.md" }, 2)], e => events.push(e));
    expect(events).toEqual([]);
    expect(() => emitAttachedPathRules({ localPathRules: [sqlRule], stepIndex: 1 }, "/work", before, after, undefined)).not.toThrow();
  });
});
