import { describe, expect, it, vi } from "vitest";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import { StructuredLogger } from "../tracing/structured-logger.js";

import { serveLogSinks } from "./serve-command.js";

// `serve` shares the boot contract with `run` and `tui` by calling the
// same resolver; this test pins the contract at serve's import site.
describe("serve boot approval level (resolveBootApprovalLevel)", () => {
  it("matches the run/tui boot contract: persisted level is the baseline", () => {
    // Persisted agent.approvalLevel=1, no flag: everything still asks.
    expect(resolveBootApprovalLevel(false, 1)).toBe(1);
    // The Privacy-tab ladder persisted 3: serve must honor it, the
    // panel promises "applies to future runs too".
    expect(resolveBootApprovalLevel(false, 3)).toBe(3);
  });

  it("--no-approval can only force level 5, never a stricter level", () => {
    expect(resolveBootApprovalLevel(true, 1)).toBe(5);
    expect(resolveBootApprovalLevel(true, 5)).toBe(5);
  });
});

// The desktop app runs `atag serve` and relays its stderr into agent.log.
// These sinks are the runtime's only way into that file: serve used to
// pass the `stderrSink` factory itself, and nothing was ever written.
describe("serve log sinks", () => {
  it("writes the runtime's structured log lines to stderr, at the configured level", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      // The runtime builds its logger this way (`createAgentRuntime`):
      // the configured level is the gate, the sinks only write.
      const logger = new StructuredLogger({
        level: "info",
        sinks: serveLogSinks(),
      });
      logger.debug("below the configured level");
      logger.warn("provider unreachable; parking the turn", {
        error: "fetch failed",
        causeCode: "ECONNREFUSED",
      });
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(written).toContain("WARN provider unreachable; parking the turn");
      expect(written).toContain('"causeCode":"ECONNREFUSED"');
      expect(written).not.toContain("below the configured level");
    } finally {
      stderr.mockRestore();
    }
  });
});
