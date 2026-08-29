import { describe, expect, it, vi } from "vitest";

import { debugReplCommand, REPL_HELP } from "./debug-repl.js";

describe("debugReplCommand --help", () => {
  it("prints usage and resolves without opening the interactive prompt", async () => {
    // Under vitest stdin is a pipe that never closes, so if --help fell
    // through to the readline loop (as it did before) this await would
    // hang until the test timeout instead of resolving.
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    try {
      const code = await debugReplCommand(["--help"]);
      expect(code).toBe(0);
      expect(stdout).toBe(REPL_HELP);
      expect(stdout).toContain("not yet implemented");
      expect(stdout).not.toContain("atomic-agent> ");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("-h behaves the same as --help", async () => {
    let stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdout += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    });
    try {
      const code = await debugReplCommand(["-h"]);
      expect(code).toBe(0);
      expect(stdout).toBe(REPL_HELP);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
