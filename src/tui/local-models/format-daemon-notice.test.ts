import { describe, expect, it } from "vitest";

import { formatDaemonNotice } from "./format-daemon-notice.js";

describe("formatDaemonNotice", () => {
  it("a crash says what happened and that a reply in progress waits", () => {
    const { text, variant } = formatDaemonNotice({
      kind: "restarting",
      cause: "died",
      reason: "the model server died",
      quickDeaths: 0,
    });
    expect(variant).toBe("warn");
    expect(text).toContain("The local model server crashed");
    expect(text).toContain("Restarting it automatically");
    expect(text).toContain("paused and continues");
  });

  it("a hang carries the watchdog's reading", () => {
    const { text } = formatDaemonNotice({
      kind: "restarting",
      cause: "wedged",
      reason: "the model server stopped answering (95 s without a reply to /health or /slots)",
      quickDeaths: 0,
    });
    expect(text).toContain("hung");
    expect(text).toContain("95 s without a reply");
  });

  it("back up is a calm notice with how long it took", () => {
    const { text, variant } = formatDaemonNotice({ kind: "restarted", afterMs: 14_200 });
    expect(variant).toBe("normal");
    expect(text).toContain("back up (restarted in 14 s)");
  });

  it("the give-up names the fault and /llm restart", () => {
    const { text, variant } = formatDaemonNotice({
      kind: "gave_up",
      deaths: 3,
      fault: "the GPU ran out of memory 12 times",
    });
    expect(variant).toBe("warn");
    expect(text).toContain("crashed 3 times within a minute");
    expect(text).toContain("the GPU ran out of memory 12 times");
    expect(text).toContain("/llm restart");
  });
});
