import { describe, expect, it } from "vitest";
import type { PluginInstallReport } from "../plugins/index.js";
import { createCodeConsentPrompt, formatCodeQuestion, formatPermissionChanges } from "./plugin-install-confirm.js";

function report(over: Partial<PluginInstallReport> = {}): PluginInstallReport {
  return {
    name: "demo",
    version: "1.3.0",
    code: ["local MCP server db: npx db-mcp", "hook on Stop: ./hooks/x.sh"],
    changes: [],
    diff: { fresh: true, codeChanged: false } as PluginInstallReport["diff"],
    ...over,
  } as PluginInstallReport;
}

describe("plugin code consent prompt", () => {
  it("is not offered without a terminal", () => {
    expect(createCodeConsentPrompt({ isTTY: () => false })).toBeUndefined();
  });

  it("shows exactly what runs and accepts only yes", async () => {
    const out: string[] = [];
    const answers = ["y", "", "nope"];
    const prompt = createCodeConsentPrompt({ isTTY: () => true, ask: async () => answers.shift()!, writeErr: t => out.push(t) })!;
    expect(await prompt(report())).toBe(true);
    expect(await prompt(report())).toBe(false);
    expect(await prompt(report())).toBe(false);
    expect(out[0]).toContain("  - local MCP server db: npx db-mcp\n  - hook on Stop: ./hooks/x.sh");
  });

  it("says why it asks again on an update", () => {
    expect(formatCodeQuestion(report({ diff: { fresh: false, codeChanged: true } as PluginInstallReport["diff"] }))).toMatch(/changed what it runs/);
  });

  it("prints the diff only on an update with changes", () => {
    expect(formatPermissionChanges(report())).toBe("");
    const text = formatPermissionChanges(report({ diff: { fresh: false } as PluginInstallReport["diff"], changes: ["New skills: b"] }));
    expect(text).toBe("Changes in demo@1.3.0:\n  - New skills: b\n");
  });
});
