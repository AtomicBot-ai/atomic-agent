import { describe, expect, it, vi } from "vitest";

import { resolveBootApprovalLevel } from "../approval/approval-level.js";
import type { CreateAgentRuntimeOptions } from "../runtime/bootstrap.js";
import { StructuredLogger } from "../tracing/structured-logger.js";

import { serveCommand } from "./serve-command.js";

/** What `serveCommand` handed `createAgentRuntime`, the last time it ran. */
const boot = vi.hoisted(() => ({
  options: null as CreateAgentRuntimeOptions | null,
}));

// `serveCommand` runs for real up to the runtime it would boot. The
// stand-in keeps the options serve built and refuses, so serve takes its
// failure path and returns without listening on anything.
vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/bootstrap.js")>();
  return {
    ...actual,
    createAgentRuntime: async (options: CreateAgentRuntimeOptions) => {
      boot.options = options;
      throw new Error("runtime stand-in: not booting");
    },
  };
});

/** Run `serve` up to its runtime and return what it passed there. */
async function serveBootOptions(): Promise<CreateAgentRuntimeOptions> {
  boot.options = null;
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  try {
    // 1: the stand-in refused, and serve said so on (silenced) stderr.
    expect(await serveCommand([])).toBe(1);
  } finally {
    stderr.mockRestore();
  }
  if (boot.options === null) throw new Error("serve never booted a runtime");
  return boot.options;
}

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
// The sinks serve passes are the runtime's only way into that file: serve
// used to pass the sink factory itself, and nothing was ever written. So
// this reads the sinks `serveCommand` really passes, not a helper's.
describe("what serve hands the runtime", () => {
  it("log sinks that write the structured log to stderr, at the configured level", async () => {
    const { handlers } = await serveBootOptions();
    const sinks = handlers?.logSinks ?? [];
    expect(sinks).toHaveLength(1);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      // The runtime builds its logger this way (`createAgentRuntime`):
      // the configured level is the gate, the sinks only write.
      const logger = new StructuredLogger({ level: "info", sinks });
      logger.debug("below the configured level");
      logger.warn("provider unreachable; parking the turn", {
        error: "fetch failed",
        causeCode: "ECONNREFUSED",
      });
      const written = stderr.mock.calls.map((c) => String(c[0])).join("");
      // The shape the desktop reads a line's level from.
      expect(written).toMatch(
        /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] WARN provider unreachable; parking the turn \{/,
      );
      expect(written).toContain('"causeCode":"ECONNREFUSED"');
      expect(written).not.toContain("below the configured level");
    } finally {
      stderr.mockRestore();
    }
  });

  // Under the desktop, a host that died leaves stderr a dead pipe, and
  // the next log line exited the process before its teardown ran (the
  // port, the session store's turn ends, the serve record). Muted, the
  // orphan watch ends it the way SIGTERM would.
  it("a broken stderr is muted, not a reason to exit", async () => {
    const options = await serveBootOptions();
    expect(options.brokenPipe).toBe("mute");
  });
});
