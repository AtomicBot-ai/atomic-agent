import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import {
  LOCAL_PATH_RULES_MAX_TOKENS,
  localPathRulesBudget,
  newlyActivePathRules,
  touchedWorkspacePaths,
} from "./path-rule-sections.js";
import { patchTargets, rewriteResultFiles } from "./path-rule-tool-targets.js";
import { estimateTokens } from "./token-budget.js";
import { createEmptySessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import { PROJECT_RULES_SECTION_LABEL, contextUsageFromPrompt } from "../session/context-usage.js";
import type { PathRule, SessionWorkspace } from "../session/workspace-context.js";

const sqlRule: PathRule = { path: ".atomic-agent/rules/sql.md", patterns: ["*.sql"], body: "SQL RULE: use snake_case table names." };
const cssRule: PathRule = { path: "~/.atomic-agent/rules/css.md", patterns: ["*.css"], body: "CSS RULE: no !important." };
const call = (tool: string, args: Record<string, unknown>, at: number) => assistantToolCallTurn({ tool, args, at });
const CAPS = { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work",
  hasClipboard: false, hasWmctrl: false, hasNotifications: false } as const;

describe("path rules part 2: os.fs.patch and os.code.rewrite targets (ATO-2443)", () => {
  it("reads the files of a unified diff, stripping a/ b/ and skipping /dev/null and removed lines", () => {
    const patch = [
      "diff --git a/db/schema.sql b/db/schema.sql",
      "--- a/db/schema.sql",
      "+++ b/db/schema.sql",
      "@@ -1,2 +1,2 @@",
      "--- old comment line that starts with two dashes",
      "+-- new comment",
      "--- /dev/null",
      "+++ b/new/table.sql",
      "--- a/gone.sql",
      "+++ /dev/null",
    ].join("\n");
    expect(patchTargets({ patch })).toEqual(["db/schema.sql", "new/table.sql", "gone.sql"]);
    expect(patchTargets({ patch: "--- schema.sql\n+++ schema.sql\n", stripComponents: 0 })).toEqual(["schema.sql"]);
  });

  it("reads the files of a *** Begin Patch envelope, the move target too, relative to rootDir", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: db/q.sql",
      "*** Move to: db/queries/q.sql",
      "@@",
      "-select 1",
      "+select 2",
      "*** Add File: docs/a.md",
      "+hi",
      "*** Delete File: old.css",
      "*** End Patch",
    ].join("\n");
    expect(patchTargets({ patch })).toEqual(["db/q.sql", "db/queries/q.sql", "docs/a.md", "old.css"]);
    expect(patchTargets({ patch: "*** Begin Patch\n*** Add File: x.sql\n+a\n*** End Patch", rootDir: "pkg/" })).toEqual(["pkg/x.sql"]);
    expect(patchTargets({ patchPath: "change.diff" })).toEqual([]);
  });

  it("reads the files an os.code.rewrite result lists", () => {
    const summary = "rewrite applied:\n  ✓ src/db/a.sql  2 matches\n  ✗ src/b.ts  1 match  changed on disk\n\n--- src/db/a.sql\n";
    expect(rewriteResultFiles(summary)).toEqual(["src/db/a.sql", "src/b.ts"]);
  });

  it("counts patch and rewrite targets as touched paths (fails if only read/write/edit/move are checked)", () => {
    const turns = [
      userTurn("go", 1),
      call("os.fs.patch", { patch: "*** Begin Patch\n*** Update File: db/schema.sql\n@@\n-a\n+b\n*** End Patch" }, 2),
      call("os.code.rewrite", { pattern: "a($A)", rewrite: "b($A)", path: "styles/site.css" }, 3),
      call("os.code.rewrite", { pattern: "a", rewrite: "b", path: "src" }, 4),
      toolResultTurn({ tool: "os.code.rewrite", status: "ok", summary: "rewrite dry-run (nothing written; apply=true writes it):\n  ✓ src/q.sql  1 match", at: 5 }),
    ];
    expect(touchedWorkspacePaths(turns, ["/work"])).toEqual(["db/schema.sql", "styles/site.css", "src", "src/q.sql"]);
  });

  it("reports a rule as new only on the step that first matched it", () => {
    const before = [userTurn("go", 1)];
    const step1 = [...before, call("os.fs.read", { path: "a.sql" }, 2)];
    const step2 = [...step1, call("os.fs.read", { path: "b.sql" }, 3), call("os.fs.read", { path: "x.css" }, 4)];
    expect(newlyActivePathRules([sqlRule, cssRule], before, step1, ["/work"])).toEqual([sqlRule]);
    expect(newlyActivePathRules([sqlRule, cssRule], step1, step2, ["/work"])).toEqual([cssRule]);
    expect(newlyActivePathRules([sqlRule, cssRule], step2, step2, ["/work"])).toEqual([]);
  });
});

function localInput(pathRules: readonly PathRule[], contextWindow?: number): BuildPromptInput {
  const session = createEmptySessionState({ id: "s", workingDir: "/work" });
  session.turns = [userTurn("fix the schema", 1)];
  return { session, toolDescriptors: [], skillCatalog: [], capabilities: { ...CAPS }, pathRules,
    ...(contextWindow !== undefined ? { contextWindow, profileWindowApplies: false } : {}) };
}

describe("path rules in a local prompt (ATO-2443)", () => {
  it("keeps the rule out until a matching file is touched, then puts it after the conversation without moving the stable prefix", () => {
    const input = localInput([sqlRule]);
    const before = buildPrompt(input);
    expect(before.text).not.toContain("SQL RULE");
    expect(before.tokens.projectRules).toBeUndefined();
    input.session.turns.push(call("os.fs.read", { path: "db/schema.sql" }, 2),
      toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "create table", at: 3 }));
    const after = buildPrompt(input);
    expect(after.stablePrefix).toBe(before.stablePrefix);
    expect(after.stablePrefix).not.toContain("SQL RULE");
    expect(after.tail).toContain("### project-rules\nSource: .atomic-agent/rules/sql.md");
    expect(after.tail.indexOf("### project-rules")).toBeGreaterThan(after.tail.indexOf("### conversation"));
    expect(after.messages.tail).toContain("SQL RULE");
    expect(after.text.split("SQL RULE")).toHaveLength(2);
  });

  it("counts the attached rules in tokens.total and as the /context row (fails without the projectRules accounting)", () => {
    const touched = localInput([sqlRule]);
    touched.session.turns.push(call("os.fs.edit", { path: "q.sql", oldString: "a", newString: "b" }, 2));
    const untouched = localInput([]);
    untouched.session.turns.push(call("os.fs.edit", { path: "q.sql", oldString: "a", newString: "b" }, 2));
    const withRule = buildPrompt(touched);
    const without = buildPrompt(untouched);
    expect(withRule.tokens.projectRules).toBeGreaterThan(0);
    expect(withRule.tokens.total - without.tokens.total).toBe(withRule.tokens.projectRules);
    expect(contextUsageFromPrompt(withRule).sections).toContainEqual({ label: PROJECT_RULES_SECTION_LABEL, tokens: withRule.tokens.projectRules });
    expect(contextUsageFromPrompt(without).sections.some(s => s.label === PROJECT_RULES_SECTION_LABEL)).toBe(false);
  });

  it("caps the section for a small window", () => {
    expect(localPathRulesBudget(null)).toBe(LOCAL_PATH_RULES_MAX_TOKENS);
    expect(localPathRulesBudget(16_384)).toBe(819);
    expect(localPathRulesBudget(1_000_000)).toBe(LOCAL_PATH_RULES_MAX_TOKENS);
    expect(localPathRulesBudget(2_000)).toBe(256);
    const big: PathRule = { ...sqlRule, body: "SQL RULE " + "keep names short. ".repeat(2000) };
    const input = localInput([big], 16_384);
    input.session.turns.push(call("os.fs.read", { path: "a.sql" }, 2));
    const prompt = buildPrompt(input);
    expect(prompt.tokens.projectRules).toBeLessThanOrEqual(localPathRulesBudget(16_384) + 8);
    expect(estimateTokens(big.body)).toBeGreaterThan(prompt.tokens.projectRules!);
  });
});

describe("path rules in a cloud prompt: /context accounting (ATO-2443)", () => {
  it("reports the journal's project-rule entries as tokens.projectRules", () => {
    const session = createEmptySessionState({ id: "c", workingDir: "/work" });
    session.turns = [userTurn("go", 1), call("os.fs.read", { path: "a.sql" }, 2)];
    const workspace = { workingDir: "/work", cloud: true, skills: { entries: [] }, instructions: [], diagnostics: [], pathRules: [sqlRule] } as unknown as SessionWorkspace;
    const input: BuildPromptInput = { session, workspace, toolDescriptors: [], skillCatalog: [], capabilities: { ...CAPS },
      modelMode: { mode: "cloud", source: "provider", providerId: "remote", modelId: "large" }, contextWindow: 200000,
      profileWindowApplies: false, toolTransport: "native_tools", suppressReasoningPrefill: true };
    const prompt = buildPrompt(input);
    expect(prompt.tokens.projectRules).toBeGreaterThan(0);
    expect(contextUsageFromPrompt(prompt).sections).toContainEqual({ label: PROJECT_RULES_SECTION_LABEL, tokens: prompt.tokens.projectRules });
    session.turns = [userTurn("go", 1)];
    session.cloudContext = undefined;
    expect(buildPrompt(input).tokens.projectRules).toBeUndefined();
  });
});
