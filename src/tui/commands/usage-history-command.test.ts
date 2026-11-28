import { describe, expect, it } from "vitest";

import type { UsageHistoryFile } from "../../session/usage-history.js";
import type { TuiAction } from "../tui-action.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";
import { runUsageHistoryCommand } from "./usage-history-command.js";

/** ATO-2442: `/usage` shows the per-day history in the TUI, not just a pointer to the CLI. */
const HISTORY: UsageHistoryFile = {
  version: 1,
  days: {
    "2026-11-12": [
      {
        billing: "local", providerId: "local", model: "qwen3-8b", calls: 2,
        inputTokens: 3000, outputTokens: 400, cachedTokens: 0, usd: 0, pricedCalls: 0, unpricedCalls: 0,
      },
    ],
  },
  tools: { "2026-11-12": { "fs.read": { calls: 3, errors: 1 } } },
};

function run(args: string, readHistory: () => UsageHistoryFile = () => HISTORY): string[] {
  const said: string[] = [];
  runUsageHistoryCommand(args, (a: TuiAction) => {
    if (a.type === "system_message") said.push(a.text);
  }, { readHistory, today: () => "2026-11-12", providers: () => ({ providers: [] }) });
  return said;
}

describe("/usage", () => {
  it("bare: this chat's report, then the history over every chat (read on the submit path)", () => {
    const result = dispatchSlashCommand("/usage");
    expect(result.actions.map((a) => a.type)).toEqual(["usage_report_requested"]);
    expect(result.usageHistoryArgs).toBe("");
    const [text] = run("");
    expect(text).toContain("Token usage, 2026-11-06 to 2026-11-12");
    expect(text).toContain("Saved by local (estimate)");
    expect(text).toContain("More: /usage --days 30 --tools --projects --sessions");
  });

  it("with options: only the history, with the same options as the CLI", () => {
    const result = dispatchSlashCommand("/usage --days 30 --tools");
    expect(result.actions).toEqual([]);
    expect(result.usageHistoryArgs).toBe("--days 30 --tools");
    const [text] = run("--days 30 --tools");
    expect(text).toContain("2026-10-14 to 2026-11-12");
    expect(text).toMatch(/\nTools\n.*\nfs\.read\s+3\s+1\s+100%/);
    expect(text).not.toContain("More: /usage");
  });

  it("an unknown option shows the help, --help shows it alone", () => {
    expect(run("--year")[0]).toMatch(/^unknown option --year\n\nUsage: \/usage /);
    expect(run("--help")[0]).toMatch(/^Usage: \/usage /);
  });

  it("says so in plain words when the history cannot be read", () => {
    const said = run("", () => {
      throw new Error("EACCES: /secret/path");
    });
    expect(said).toEqual(["Could not read the usage history just now. Try again, or run atomic-agent usage in a terminal."]);
  });
});
