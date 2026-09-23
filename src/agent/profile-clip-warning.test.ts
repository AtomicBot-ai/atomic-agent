import { describe, expect, it } from "vitest";

import type { ProfileClipStats } from "../prompt/clip-profile-section.js";
import type { StructuredLogger } from "../tracing/structured-logger.js";

import {
  ProfileClipWarnings,
  reportProfileClip,
  type ProfileClippedEvent,
} from "./profile-clip-warning.js";

/**
 * Issue #407. The `### profile` clip runs on every step; the warning
 * about it must reach the operator once per session — and again only
 * when the number of pinned facts left out changes — never once per
 * turn. The loop-level wiring is pinned in `agent-loop-profile-clip`.
 */

interface Captured {
  warnings: Array<{ message: string; fields?: Record<string, unknown> }>;
  events: ProfileClippedEvent[];
  logger: StructuredLogger;
  emit: (event: ProfileClippedEvent) => void;
}

function capture(): Captured {
  const warnings: Captured["warnings"] = [];
  const events: ProfileClippedEvent[] = [];
  const noop = (): void => {};
  const logger = {
    debug: noop,
    info: noop,
    error: noop,
    warn(message: string, fields?: Record<string, unknown>) {
      warnings.push({ message, ...(fields ? { fields } : {}) });
    },
  } as unknown as StructuredLogger;
  return { warnings, events, logger, emit: (event) => events.push(event) };
}

const stats = (dropped: number, pinnedDropped = 0): ProfileClipStats => ({
  rendered: 10,
  dropped,
  pinnedDropped,
  maxTokens: 512,
});

describe("reportProfileClip", () => {
  const report = (
    c: Captured,
    warnings: ProfileClipWarnings,
    sessionId: string,
    stepIndex: number,
    clip: ProfileClipStats | undefined,
  ): void =>
    reportProfileClip({
      warnings,
      sessionId,
      stepIndex,
      clip,
      logger: c.logger,
      emit: c.emit,
    });

  it("warns once per session while the counts stay the same", () => {
    const c = capture();
    const warnings = new ProfileClipWarnings();
    for (let step = 0; step < 5; step += 1) {
      report(c, warnings, "s", step, stats(3, 1));
    }
    expect(c.events).toEqual([
      {
        type: "profile_clipped",
        stepIndex: 0,
        rendered: 10,
        dropped: 3,
        pinnedDropped: 1,
        maxTokens: 512,
      },
    ]);
    expect(c.warnings).toEqual([
      {
        message: "profile section clipped at memory.profile.maxTokens",
        fields: {
          sessionId: "s",
          stepIndex: 0,
          rendered: 10,
          dropped: 3,
          pinnedDropped: 1,
          maxTokens: 512,
        },
      },
    ]);
  });

  it("warns again when the number of pinned facts left out changes", () => {
    const c = capture();
    const warnings = new ProfileClipWarnings();
    report(c, warnings, "s", 0, stats(3, 1));
    report(c, warnings, "s", 1, stats(4, 2));
    report(c, warnings, "s", 2, stats(4, 2));
    report(c, warnings, "s", 3, stats(6, 3));
    expect(c.events.map((e) => [e.dropped, e.pinnedDropped])).toEqual([
      [3, 1],
      [4, 2],
      [6, 3],
    ]);
    expect(c.warnings).toHaveLength(3);
  });

  it("does not warn again when only keyword-gated drops vary with the message", () => {
    const c = capture();
    const warnings = new ProfileClipWarnings();
    for (const dropped of [3, 5, 2, 9, 3]) {
      report(c, warnings, "s", 0, stats(dropped, 1));
    }
    expect(c.events.map((e) => e.dropped)).toEqual([3]);
  });

  it("says nothing for a prompt that fit, and a fitting step does not re-arm it", () => {
    const c = capture();
    const warnings = new ProfileClipWarnings();
    report(c, warnings, "s", 0, undefined);
    report(c, warnings, "s", 1, stats(2));
    report(c, warnings, "s", 2, undefined);
    report(c, warnings, "s", 3, stats(2));
    expect(c.events.map((e) => e.stepIndex)).toEqual([1]);
  });

  it("keeps sessions apart", () => {
    const c = capture();
    const warnings = new ProfileClipWarnings();
    report(c, warnings, "a", 0, stats(2));
    report(c, warnings, "b", 0, stats(2));
    report(c, warnings, "a", 1, stats(2));
    expect(c.warnings.map((w) => w.fields?.sessionId)).toEqual(["a", "b"]);
  });
});
