import { describe, expect, it } from "vitest";

import type { SubscriptionCliStatusReport } from "../llm/provider/subscription-cli/index.js";
import { formatStatusLine, providersCommand } from "./providers-command.js";

function report(over: Partial<SubscriptionCliStatusReport>): SubscriptionCliStatusReport {
  return {
    cli: "codex", productName: "Codex", state: "ready", installed: true, version: "0.46.0",
    signedIn: true, loginCheck: "command", fix: null, message: "Codex 0.46.0 is installed and signed in.", billingEnvSet: [],
    ...over,
  };
}

function harness(reports: Record<string, SubscriptionCliStatusReport>, binPaths = {}) {
  let out = "";
  const asked: Array<[string, string | undefined]> = [];
  const deps = {
    write: (t: string) => { out += t; },
    binPaths: () => binPaths,
    check: async (cli: "claude" | "codex", binPath: string | undefined) => { asked.push([cli, binPath]); return reports[cli]!; },
  };
  return { deps, asked, out: () => out };
}

describe("atomic-agent providers status (ATO-1200)", () => {
  it("checks both CLIs by default and exits 1 when one is not ready", async () => {
    const h = harness({
      claude: report({ cli: "claude", productName: "Claude Code", state: "missing", installed: false, version: null, signedIn: false, fix: "curl -fsSL https://claude.ai/install.sh | bash" }),
      codex: report({}),
    });
    expect(await providersCommand(["status"], h.deps)).toBe(1);
    expect(h.asked.map((a) => a[0])).toEqual(["claude", "codex"]);
    expect(h.out()).toMatch(/Claude Code\s+not installed\s+-\s+run: curl -fsSL/);
    expect(h.out()).toMatch(/Codex\s+ready\s+0\.46\.0/);
  });

  it("--cli codex --json prints the report and exits 0 when ready", async () => {
    const h = harness({ codex: report({}) });
    expect(await providersCommand(["status", "--cli", "codex", "--json"], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out());
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ cli: "codex", state: "ready", version: "0.46.0" });
  });

  it("passes the configured binPath through", async () => {
    const h = harness({ codex: report({}) }, { codex: "/opt/codex/bin/codex" });
    await providersCommand(["status", "--cli=codex"], h.deps);
    expect(h.asked).toEqual([["codex", "/opt/codex/bin/codex"]]);
  });

  it("usage errors exit 2 and run nothing", async () => {
    const h = harness({});
    expect(await providersCommand([], h.deps)).toBe(2);
    expect(await providersCommand(["status", "--cli", "gemini"], h.deps)).toBe(2);
    expect(await providersCommand(["status", "--verbose"], h.deps)).toBe(2);
    expect(await providersCommand(["list"], h.deps)).toBe(2);
    expect(h.asked).toEqual([]);
    expect(await providersCommand(["--help"], h.deps)).toBe(0);
  });

  it("the unknown state reads as can't verify login", () => {
    const line = formatStatusLine(report({ cli: "claude", productName: "Claude Code", state: "unknown", signedIn: null, loginCheck: "none", message: "Can't verify the login without spending your plan." }));
    expect(line).toMatch(/can't verify login/);
  });

  it("a set billing variable is named under the line", () => {
    expect(formatStatusLine(report({ billingEnvSet: ["OPENAI_API_KEY"] }))).toMatch(/OPENAI_API_KEY set: the CLI may bill per token/);
  });
});
