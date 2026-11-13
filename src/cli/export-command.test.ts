import { describe, expect, it } from "vitest";

import { parseExportArgs } from "./export-command.js";

describe("atomic-agent export args (ATO-1054)", () => {
  it("defaults to Markdown on stdout with tool lines", () => {
    expect(parseExportArgs(["s-1"])).toEqual({ sessionId: "s-1", last: false, format: "markdown", out: null, tools: true });
  });

  it("takes --last, --format, --out and --no-tools", () => {
    expect(parseExportArgs(["--last", "--format", "docx", "--out", "a.docx", "--no-tools"])).toEqual({
      sessionId: "",
      last: true,
      format: "docx",
      out: "a.docx",
      tools: false,
    });
  });

  it("refuses bad usage with a reason", () => {
    expect(parseExportArgs([])).toMatch(/session id or --last/);
    expect(parseExportArgs(["s-1", "--last"])).toMatch(/not both/);
    expect(parseExportArgs(["s-1", "s-2"])).toMatch(/one session id/);
    expect(parseExportArgs(["s-1", "--format", "pdf"])).toMatch(/unknown format: pdf/);
    expect(parseExportArgs(["s-1", "--out"])).toMatch(/--out needs a value/);
    expect(parseExportArgs(["s-1", "--bogus"])).toMatch(/unknown option/);
  });
});
