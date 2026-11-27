import { describe, expect, it } from "vitest";
import { buildPrompt } from "./build-prompt.js";
import type { BuildPromptInput } from "./build-prompt-types.js";
import { activePathRules, pathRuleMatches, touchedWorkspacePaths } from "./path-rule-sections.js";
import { createEmptySessionState } from "../session/session-state.js";
import { assistantToolCallTurn, toolResultTurn, userTurn } from "../session/conversation-turn.js";
import type { PathRule, SessionWorkspace } from "../session/workspace-context.js";

const sqlRule: PathRule = { path: ".atomic-agent/rules/sql.md", patterns: ["*.sql"], body: "SQL RULE: use snake_case table names." };
const docsRule: PathRule = { path: ".cursor/rules/docs.mdc", patterns: ["docs/**"], body: "DOCS RULE: write in plain English." };
const call = (tool: string, args: Record<string, unknown>, at: number) => assistantToolCallTurn({ tool, args, at });

describe("path-scoped project rules (ATO-2247)", () => {
  it("matches a bare pattern by file name in any folder and a pattern with a slash from the root", () => {
    expect(pathRuleMatches(["*.sql"], "schema.sql")).toBe(true);
    expect(pathRuleMatches(["*.sql"], "db/migrations/001.sql")).toBe(true);
    expect(pathRuleMatches(["*.sql"], "db/notes.md")).toBe(false);
    expect(pathRuleMatches(["docs/**"], "docs/guide/intro.md")).toBe(true);
    expect(pathRuleMatches(["./docs/*.md"], "docs/a.md")).toBe(true);
    expect(pathRuleMatches(["docs/**"], "src/docs/a.md")).toBe(false);
    expect(pathRuleMatches(["src/**/*.{ts,tsx}"], "src/ui/app.tsx")).toBe(true);
  });

  it("collects paths only from file tools, relative to the workspace, and ignores paths outside it", () => {
    const turns = [
      userTurn("go", 1),
      call("os.fs.read", { path: "db/schema.sql" }, 2),
      call("os.fs.write", { path: "/work/docs/a.md", content: "x" }, 3),
      call("os.fs.move", { moves: [{ from: "a.txt", to: "b/c.txt" }] }, 4),
      call("os.shell.run", { cmd: "cat other.sql" }, 5),
      call("os.fs.edit", { path: "../outside.sql", oldString: "a", newString: "b" }, 6),
      call("os.fs.read", { path: "/elsewhere/x.sql" }, 7),
    ];
    expect(touchedWorkspacePaths(turns, ["/work"])).toEqual(["db/schema.sql", "docs/a.md", "a.txt", "b/c.txt"]);
  });

  it("activates only the rules a touched file matches", () => {
    const turns = [userTurn("go", 1), call("os.fs.edit", { path: "db/q.sql", oldString: "a", newString: "b" }, 2)];
    expect(activePathRules([sqlRule, docsRule], turns, ["/work"])).toEqual([sqlRule]);
    expect(activePathRules([sqlRule, docsRule], [userTurn("go", 1)], ["/work"])).toEqual([]);
  });

  it("keeps a rule out of the prompt until a matching file is read, then appends it after the conversation without moving the stable prefix", () => {
    const session = createEmptySessionState({ id: "rules", workingDir: "/work" });
    session.turns = [userTurn("look at the database", 1)];
    const workspace = { workingDir: "/work", cloud: true, skills: { entries: [] }, instructions: [], diagnostics: [], pathRules: [sqlRule] } as unknown as SessionWorkspace;
    const input: BuildPromptInput = { session, workspace, toolDescriptors: [], skillCatalog: [],
      capabilities: { platform: "darwin", arch: "arm64", browserChannel: "chrome", workingDir: "/work", hasClipboard: false, hasWmctrl: false, hasNotifications: false },
      modelMode: { mode: "cloud", source: "provider", providerId: "remote", modelId: "large" }, contextWindow: 200000, profileWindowApplies: false,
      toolTransport: "native_tools", suppressReasoningPrefill: true,
      tokenBudget: 1, conversationMaxTokens: 1, conversationMaxPairs: 1, sessionSectionsMaxTokens: 1,
      worldSnapshotMaxTokens: 1, loadedToolsMaxTokens: 1, recallMaxTokens: 1, profileMaxTokens: 1 };
    const before = buildPrompt(input);
    expect(before.text).not.toContain("SQL RULE");
    session.cloudContext = before.cloudContext;
    session.turns.push(call("os.fs.read", { path: "db/notes.md" }, 2), toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "notes", at: 3 }));
    const unrelated = buildPrompt(input);
    expect(unrelated.text).not.toContain("SQL RULE");
    session.cloudContext = unrelated.cloudContext;
    session.turns.push(call("os.fs.read", { path: "db/schema.sql" }, 4), toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "create table", at: 5 }));
    const after = buildPrompt(input);
    expect(after.stablePrefix).toBe(before.stablePrefix);
    expect(after.stablePrefix).not.toContain("SQL RULE");
    expect(after.text).toContain("### project-rule:.atomic-agent/rules/sql.md");
    expect(after.text).toContain("SQL RULE");
    // The rule is a journal entry after the read that triggered it.
    expect(after.text.indexOf("SQL RULE")).toBeGreaterThan(after.text.indexOf("create table"));
    session.cloudContext = after.cloudContext;
    session.turns.push(call("os.fs.read", { path: "db/other.sql" }, 6));
    expect(buildPrompt(input).text.split("SQL RULE")).toHaveLength(2); // attached once
  });
});
