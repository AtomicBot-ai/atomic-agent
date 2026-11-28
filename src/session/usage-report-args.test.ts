import { describe, expect, it } from "vitest";

import { parseUsageArgs, usageHelp } from "./usage-report-args.js";

/** ATO-2442: the options `atomic-agent usage` and the TUI's `/usage` share. */
describe("parseUsageArgs", () => {
  it("defaults to the last 7 days with nothing extra", () => {
    expect(parseUsageArgs([])).toEqual({
      ok: true,
      options: { days: 7, models: false, tools: false, projects: false, sessions: false, json: false, compare: null, help: false },
    });
  });

  it("reads every flag, --compare in both forms", () => {
    const a = parseUsageArgs(["--tools", "--projects", "--sessions", "--models", "--json", "--compare", "google/gemini-flash-lite-latest", "--days", "30"]);
    expect(a).toMatchObject({
      ok: true,
      options: { days: 30, tools: true, projects: true, sessions: true, models: true, json: true, compare: "google/gemini-flash-lite-latest" },
    });
    expect(parseUsageArgs(["--compare=deepseek-v4-flash", "--all", "--project"])).toMatchObject({
      ok: true,
      options: { days: "all", compare: "deepseek-v4-flash", projects: true },
    });
  });

  it("refuses --compare without a model, a bad --days and unknown words", () => {
    for (const args of [["--compare"], ["--compare", "--json"], ["--compare="], ["--days", "0"], ["--days", "1.5"], ["--year"]]) {
      expect(parseUsageArgs(args).ok).toBe(false);
    }
  });

  it("names the command it helps with and every option", () => {
    const help = usageHelp("/usage");
    expect(help.startsWith("Usage: /usage ")).toBe(true);
    for (const flag of ["--tools", "--projects", "--sessions", "--compare <model>", "--json"]) expect(help).toContain(flag);
    expect(help).toContain("estimate");
  });
});
