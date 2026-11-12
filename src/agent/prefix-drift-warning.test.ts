import { describe, expect, it } from "vitest";

import {
  ALL_PREFIX_SECTIONS,
  notePrefixInvalidation,
  PrefixDriftTracker,
  PrefixInvalidationLedger,
  prefixDriftInfoLine,
  prefixDriftWarning,
  reportPrefixDrift,
  type PrefixDriftEvent,
} from "./prefix-drift-warning.js";

/**
 * ATO-316. The stable prefix is compared with the previous step of the
 * same session; a change is reported live, labelled expected when the
 * runtime itself just rebuilt it, and named by section.
 */

function prefix(over: { persona?: string; skills?: string; tools?: string } = {}): string {
  return [
    "### system",
    over.persona ?? "You are an agent.",
    "",
    "### skills",
    over.skills ?? "- [global] a: first\n- [global] b: second",
    "",
    "### tools",
    over.tools ?? "- os.fs.read: Read a file.",
    "",
    "### instructions",
    "Emit a JSON ARRAY.",
    "",
  ].join("\n");
}

const SHAPE = "local|qwen|local";

function observe(
  tracker: PrefixDriftTracker,
  stablePrefix: string,
  opts: { sessionId?: string; stepIndex?: number; shapeKey?: string; ledger?: PrefixInvalidationLedger } = {},
): PrefixDriftEvent | null {
  return tracker.observe({
    sessionId: opts.sessionId ?? "s",
    stepIndex: opts.stepIndex ?? 0,
    stablePrefix,
    shapeKey: opts.shapeKey ?? SHAPE,
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
  });
}

describe("PrefixDriftTracker", () => {
  it("says nothing on the first step or while the prefix stays byte-identical", () => {
    const tracker = new PrefixDriftTracker();
    expect(observe(tracker, prefix())).toBeNull();
    expect(observe(tracker, prefix(), { stepIndex: 1 })).toBeNull();
    expect(observe(tracker, prefix(), { stepIndex: 2 })).toBeNull();
  });

  it("flags a timestamp in a tool description as unexpected drift of the tool catalog", () => {
    const tracker = new PrefixDriftTracker();
    observe(tracker, prefix({ tools: "- os.fs.read: Read a file. (12:00:01)" }));
    const event = observe(tracker, prefix({ tools: "- os.fs.read: Read a file. (12:00:07)" }), { stepIndex: 1 });
    expect(event).toEqual({
      type: "prefix_drift",
      stepIndex: 1,
      changedSections: ["tools"],
      expected: false,
      reasons: [],
      repeat: false,
    });
  });

  it("flags a reordered skill list as unexpected when nothing refreshed skills", () => {
    const tracker = new PrefixDriftTracker();
    const ledger = new PrefixInvalidationLedger();
    observe(tracker, prefix(), { ledger });
    const event = observe(tracker, prefix({ skills: "- [global] b: second\n- [global] a: first" }), { ledger });
    expect(event?.changedSections).toEqual(["skills"]);
    expect(event?.expected).toBe(false);
  });

  it("labels a skill refresh as expected when only skills moved", () => {
    const tracker = new PrefixDriftTracker();
    const ledger = new PrefixInvalidationLedger();
    observe(tracker, prefix(), { ledger });
    ledger.note("skills refreshed", ["skills"]);
    const event = observe(tracker, prefix({ skills: "- [global] a: first" }), { ledger });
    expect(event).toMatchObject({ changedSections: ["skills"], expected: true, reasons: ["skills refreshed"] });
  });

  it("stays unexpected when a section outside the note moved too", () => {
    const tracker = new PrefixDriftTracker();
    const ledger = new PrefixInvalidationLedger();
    observe(tracker, prefix(), { ledger });
    ledger.note("skills refreshed", ["skills"]);
    const event = observe(tracker, prefix({ skills: "- [global] a: first", persona: "You are someone else." }), { ledger });
    expect(event?.changedSections).toEqual(["system", "skills"]);
    expect(event?.expected).toBe(false);
  });

  it("uses a note only once: the next unexplained change warns again", () => {
    const tracker = new PrefixDriftTracker();
    const ledger = new PrefixInvalidationLedger();
    observe(tracker, prefix(), { ledger });
    ledger.note("skills refreshed", ["skills"]);
    expect(observe(tracker, prefix({ skills: "x" }), { ledger })?.expected).toBe(true);
    expect(observe(tracker, prefix({ skills: "y" }), { ledger })?.expected).toBe(false);
  });

  it("treats a model or route switch as expected for every section", () => {
    const tracker = new PrefixDriftTracker();
    observe(tracker, prefix());
    const event = observe(tracker, prefix({ persona: "Native persona.", tools: "other" }), { shapeKey: "openrouter|gpt|cloud" });
    expect(event).toMatchObject({ expected: true, reasons: ["model, route or run mode changed"] });
  });

  it("covers every section for an 'all' note", () => {
    const tracker = new PrefixDriftTracker();
    const ledger = new PrefixInvalidationLedger();
    observe(tracker, prefix(), { ledger });
    ledger.note("tool catalog rebuilt", ALL_PREFIX_SECTIONS);
    expect(observe(tracker, prefix({ persona: "p", tools: "t" }), { ledger })?.expected).toBe(true);
  });

  it("marks repeated unexpected drift of the same sections as a repeat", () => {
    const tracker = new PrefixDriftTracker();
    observe(tracker, prefix({ tools: "1" }));
    expect(observe(tracker, prefix({ tools: "2" }))?.repeat).toBe(false);
    expect(observe(tracker, prefix({ tools: "3" }))?.repeat).toBe(true);
    expect(observe(tracker, prefix({ tools: "3", skills: "z" }))?.repeat).toBe(false);
  });

  it("keeps sessions apart", () => {
    const tracker = new PrefixDriftTracker();
    observe(tracker, prefix(), { sessionId: "a" });
    expect(observe(tracker, prefix({ tools: "other" }), { sessionId: "b" })).toBeNull();
    expect(observe(tracker, prefix(), { sessionId: "a" })).toBeNull();
  });
});

describe("PrefixInvalidationLedger", () => {
  it("reports an incomplete window once old notes were dropped", () => {
    const ledger = new PrefixInvalidationLedger();
    for (let i = 0; i < 70; i += 1) ledger.note(`n${i}`, ["skills"]);
    expect(ledger.since(0).complete).toBe(false);
    expect(ledger.since(ledger.current() - 3)).toMatchObject({ complete: true });
    expect(ledger.since(ledger.current() - 3).notes).toHaveLength(3);
  });
});

describe("notePrefixInvalidation", () => {
  it("records the note after the action settles, even when it throws", async () => {
    const ledger = new PrefixInvalidationLedger();
    const ok = notePrefixInvalidation(async () => {
      expect(ledger.current()).toBe(0);
    }, ledger, "skills refreshed", ["skills"]);
    await ok();
    expect(ledger.since(0).notes.map((n) => n.reason)).toEqual(["skills refreshed"]);
    const failing = notePrefixInvalidation(async () => {
      throw new Error("boom");
    }, ledger, "tool catalog rebuilt", ["tools"]);
    await expect(failing()).rejects.toThrow("boom");
    expect(ledger.current()).toBe(2);
  });
});

describe("reportPrefixDrift", () => {
  it("emits only when the prefix moved", () => {
    const tracker = new PrefixDriftTracker();
    const events: PrefixDriftEvent[] = [];
    const run = (p: string, stepIndex: number): void =>
      reportPrefixDrift({ tracker, sessionId: "s", stepIndex, stablePrefix: p, shapeKey: SHAPE, emit: (e) => events.push(e) });
    run(prefix(), 0);
    run(prefix(), 1);
    run(prefix({ tools: "changed" }), 2);
    expect(events.map((e) => e.stepIndex)).toEqual([2]);
  });
});

describe("notice text", () => {
  const base: PrefixDriftEvent = {
    type: "prefix_drift",
    stepIndex: 3,
    changedSections: ["system", "tools"],
    expected: false,
    reasons: [],
    repeat: false,
  };

  it("names the changed sections in plain words for unexpected drift", () => {
    const text = prefixDriftWarning(base);
    expect(text.startsWith("Warning:")).toBe(true);
    expect(text).toContain("(persona, tool catalog)");
    expect(text).not.toContain("—");
  });

  it("gives the reason on the quiet line for expected drift", () => {
    expect(prefixDriftInfoLine({ ...base, changedSections: ["skills"], expected: true, reasons: ["skills refreshed"] }))
      .toBe("» prompt prefix rebuilt (skills): skills refreshed");
  });
});
