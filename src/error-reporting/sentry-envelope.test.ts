import { describe, expect, it } from "vitest";

import { parseSentryDsn } from "./sentry-config.js";
import { buildEnvelope } from "./sentry-envelope.js";
import type { ScrubbedErrorEvent } from "./error-scrubber.js";

const DSN = parseSentryDsn("https://pub@o1.ingest.sentry.io/7")!;
const META = { installId: "install-1", release: "1.2.3", platform: "darwin" };

function parseEventPayload(body: string): {
  tags: Record<string, string>;
  fingerprint: string[];
  exception: { values: Array<{ type: string; value: string }> };
} {
  const lines = body.trim().split("\n");
  return JSON.parse(lines[2]!);
}

describe("buildEnvelope", () => {
  it("stamps a cause_type tag when the scrubbed event carries one", () => {
    const ev: ScrubbedErrorEvent = {
      errorType: "ToolExecutionError",
      causeType: "RangeError",
      source: "llm_failure",
      category: "tool",
      tool: "unknown",
      frames: [],
    };
    const { body } = buildEnvelope(DSN, ev, META);
    const payload = parseEventPayload(body);
    expect(payload.tags.cause_type).toBe("RangeError");
  });

  it("omits cause_type when the scrubbed event has none", () => {
    const ev: ScrubbedErrorEvent = {
      errorType: "TransportError",
      source: "llm_failure",
      frames: [],
    };
    const { body } = buildEnvelope(DSN, ev, META);
    const payload = parseEventPayload(body);
    expect(payload.tags.cause_type).toBeUndefined();
  });

  it("uses the innermost frame (frames[0]) for the fingerprint, not the outermost", () => {
    const evInnermostFirst: ScrubbedErrorEvent = {
      errorType: "ToolExecutionError",
      source: "llm_failure",
      tool: "unknown",
      frames: [
        { filename: "build-prompt.ts", lineno: 87 },
        { filename: "step-executor.ts", lineno: 272 },
        { filename: "chat-orchestrator.ts", lineno: 372 },
      ],
    };
    const { body } = buildEnvelope(DSN, evInnermostFirst, META);
    const payload = parseEventPayload(body);
    // The last fingerprint entry is the topFrame discriminator.
    expect(payload.fingerprint.at(-1)).toBe("build-prompt.ts");
    expect(payload.fingerprint.at(-1)).not.toBe("chat-orchestrator.ts");
  });

  it("prioritises causeType over the generic 'unknown' tool literal in the fingerprint", () => {
    const evA: ScrubbedErrorEvent = {
      errorType: "ToolExecutionError",
      causeType: "TypeError",
      source: "llm_failure",
      tool: "unknown",
      frames: [{ filename: "build-prompt.ts", lineno: 1 }],
    };
    const evB: ScrubbedErrorEvent = {
      errorType: "ToolExecutionError",
      causeType: "RangeError",
      source: "llm_failure",
      tool: "unknown",
      frames: [{ filename: "build-prompt.ts", lineno: 1 }],
    };
    const payloadA = parseEventPayload(buildEnvelope(DSN, evA, META).body);
    const payloadB = parseEventPayload(buildEnvelope(DSN, evB, META).body);
    // Different original causes must not collapse into the same
    // fingerprint just because they share the generic "unknown" tool tag.
    expect(payloadA.fingerprint).not.toEqual(payloadB.fingerprint);
  });
});
