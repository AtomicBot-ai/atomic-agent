import { describe, expect, it } from "vitest";

import {
  MEMORY_HEALTH_REASON_MAX_CHARS,
  formatSubcallHealthWarning,
  selectSubcallHealthSetting,
  summarizeFailureReason,
} from "./format-subcall-health-warning.js";
import type { MemorySubcallKind } from "./track-subcall-health.js";

const SETTINGS: readonly [MemorySubcallKind, string, string][] = [
  ["reflection", "memory.reflection.timeoutMs", "memory.reflection.enabled"],
  [
    "link_generator",
    "memory.links.generatorTimeoutMs",
    "memory.links.autoGenerate",
  ],
  ["vote", "memory.reflection.timeoutMs", "memory.voting.enabled"],
  [
    "rewriter",
    "memory.retrieve.rewriter.timeoutMs",
    "memory.retrieve.rewriter.enabled",
  ],
];

describe("selectSubcallHealthSetting", () => {
  it.each(SETTINGS)(
    "%s: a timeout names %s, a failure names %s",
    (kind, timeoutKey, switchKey) => {
      expect(selectSubcallHealthSetting(kind, "timeout")).toBe(timeoutKey);
      expect(selectSubcallHealthSetting(kind, "failed")).toBe(switchKey);
    },
  );
});

describe("formatSubcallHealthWarning", () => {
  it.each(SETTINGS)(
    "%s timeout: names the timeout key and the reasoning-model hint",
    (kind, timeoutKey, switchKey) => {
      const text = formatSubcallHealthWarning({
        kind,
        outcome: "timeout",
        consecutive: 3,
      });
      expect(text).toContain(`Raise ${timeoutKey}`);
      expect(text).toContain("hosted reasoning models often need tens of seconds");
      expect(text).toContain("timed out 3 times in a row");
      expect(text).not.toContain(switchKey);
      expect(text.split("\n")).toHaveLength(2);
      // No default values: a sibling change moves them.
      expect(text).not.toMatch(/\d{2,}/);
    },
  );

  it.each(SETTINGS)(
    "%s failure: names the switch and quotes the reason",
    (kind, timeoutKey, switchKey) => {
      const text = formatSubcallHealthWarning({
        kind,
        outcome: "failed",
        consecutive: 4,
        reason: "provider refused the schema",
      });
      expect(text).toContain(`set ${switchKey} to false`);
      expect(text).toContain("failed 4 times in a row (provider refused the schema)");
      if (timeoutKey !== switchKey) expect(text).not.toContain(timeoutKey);
      expect(text.split("\n")).toHaveLength(2);
    },
  );

  it("says the vote timeout is shared with reflection", () => {
    expect(
      formatSubcallHealthWarning({ kind: "vote", outcome: "timeout", consecutive: 3 }),
    ).toContain("memory.reflection.timeoutMs (voting shares it)");
  });

  it("the link generator warning says why an empty graph matters", () => {
    expect(
      formatSubcallHealthWarning({
        kind: "link_generator",
        outcome: "failed",
        consecutive: 3,
      }),
    ).toContain("no lessons get distilled");
  });

  it("omits the parentheses when a failure carried no reason", () => {
    const text = formatSubcallHealthWarning({
      kind: "reflection",
      outcome: "failed",
      consecutive: 3,
    });
    expect(text).toContain("failed 3 times in a row, so");
    expect(text).not.toContain("()");
  });
});

describe("summarizeFailureReason", () => {
  it("collapses a multi-line provider message to one line", () => {
    expect(summarizeFailureReason("  400 Bad Request\n\n  schema  invalid ")).toBe(
      "400 Bad Request schema invalid",
    );
  });

  it("caps a long reason with an ellipsis", () => {
    const out = summarizeFailureReason("x".repeat(500));
    expect(out).toHaveLength(MEMORY_HEALTH_REASON_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });

  it("masks anything shaped like a credential, even at the cap", () => {
    const key = `sk-or-v1-${"a1".repeat(30)}`;
    const out = summarizeFailureReason(
      `Authorization: Bearer ${"t".repeat(40)} failed; api_key=${"z".repeat(20)} ${"y".repeat(100)} ${key}`,
    );
    expect(out).not.toContain("t".repeat(16));
    expect(out).not.toContain("z".repeat(6));
    expect(summarizeFailureReason(`bad key ${key}`)).toBe("bad key <key>");
  });
});
