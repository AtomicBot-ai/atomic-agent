import { describe, expect, it } from "vitest";
import {
  ANNOTATE_READ_SCRIPT,
  ANNOTATE_START_SCRIPT,
  ANNOTATE_STATE_KEY,
  ANNOTATE_STOP_SCRIPT,
  annotateVisibilityScript,
} from "./annotate-in-page.js";

/**
 * The annotate overlay scripts (ATO-518). They run in a real page through
 * CDP, so here only their shape is pinned: they parse, and they keep the
 * safety properties the README promises.
 */

describe("annotate page scripts", () => {
  it("parse as JavaScript", () => {
    for (const source of [
      ANNOTATE_START_SCRIPT,
      ANNOTATE_READ_SCRIPT,
      ANNOTATE_STOP_SCRIPT,
      annotateVisibilityScript(true),
      annotateVisibilityScript(false),
    ]) {
      expect(() => new Function(source)).not.toThrow();
    }
  });

  it("use a closed shadow root, trusted events only, and no CSP-sensitive sinks", () => {
    expect(ANNOTATE_START_SCRIPT).toContain('attachShadow({ mode: "closed" })');
    expect(ANNOTATE_START_SCRIPT).toContain("event.isTrusted");
    expect(ANNOTATE_START_SCRIPT).not.toContain("innerHTML");
    expect(ANNOTATE_START_SCRIPT).not.toContain("<style");
    // Never reads what is typed in the page's own fields.
    expect(ANNOTATE_START_SCRIPT.replaceAll("area.value", "")).not.toContain(".value");
  });

  it("read and stop do nothing on a page without the overlay", () => {
    const fakeWindow: Record<string, unknown> = {};
    const run = (source: string) => new Function("window", `return ${source};`)(fakeWindow);
    expect(run(ANNOTATE_READ_SCRIPT)).toEqual({ active: false, picking: false, pins: [] });
    expect(run(ANNOTATE_STOP_SCRIPT)).toBe(0);
    expect(run(annotateVisibilityScript(false))).toBe(true);
    expect(fakeWindow[ANNOTATE_STATE_KEY]).toBeUndefined();
  });

  it("read refreshes facts for attached pins and keeps the saved ones for removed elements", () => {
    const el = { isConnected: true };
    const gone = { isConnected: false };
    const fakeWindow: Record<string, unknown> = {
      [ANNOTATE_STATE_KEY]: {
        picking: true,
        factsOf: () => ({ selector: "#fresh" }),
        pins: [
          { id: 1, comment: "a", el, facts: { selector: "#old" } },
          { id: 2, comment: "b", el: gone, facts: { selector: "#saved" } },
        ],
      },
    };
    const read = new Function("window", `return ${ANNOTATE_READ_SCRIPT};`)(fakeWindow);
    expect(read).toEqual({
      active: true,
      picking: true,
      pins: [
        { id: 1, comment: "a", attached: true, selector: "#fresh" },
        { id: 2, comment: "b", attached: false, selector: "#saved" },
      ],
    });
  });
});
