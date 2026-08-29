import { describe, expect, it } from "vitest";

import { parseTuiArgs, TUI_HELP } from "./tui-args.js";

describe("parseTuiArgs --help", () => {
  it("returns the help marker for --help and -h", () => {
    expect(parseTuiArgs(["--help"])).toEqual({ help: true });
    expect(parseTuiArgs(["-h"])).toEqual({ help: true });
  });

  it("keeps unknown flags as usage errors", () => {
    expect(parseTuiArgs(["--nope"])).toHaveProperty("error");
  });

  it("documents every real flag in the help text", () => {
    for (const flag of ["--cwd", "--working-dir", "--max-steps", "--no-approval", "--skip-llama-setup"]) {
      expect(TUI_HELP).toContain(flag);
    }
  });
});
