import { describe, it, expect } from "vitest";
import { LoopDetector, formatRepeatNotice } from "./loop-detector.js";

describe("LoopDetector", () => {
  it("returns ok when steps differ", () => {
    const d = new LoopDetector();
    expect(
      d.observe({
        tool: "browser.click",
        args: { ref: "e1" },
        resultSummary: "clicked ref=e1",
        worldDigest: "w1",
      }),
    ).toEqual({ kind: "ok" });
    expect(
      d.observe({
        tool: "browser.click",
        args: { ref: "e2" },
        resultSummary: "clicked ref=e2",
        worldDigest: "w1",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("fires on three identical consecutive steps with stable world", () => {
    const d = new LoopDetector({ threshold: 3 });
    const step = {
      tool: "browser.click",
      args: { ref: "e175" },
      resultSummary: "clicked ref=e175",
      worldDigest: "deadbeef",
    };
    expect(d.observe(step).kind).toBe("ok");
    expect(d.observe(step).kind).toBe("ok");
    const third = d.observe(step);
    expect(third.kind).toBe("repeat");
    if (third.kind === "repeat") {
      expect(third.count).toBe(3);
      expect(third.tool).toBe("browser.click");
    }
  });

  it("does not fire when world digest changes between repeats", () => {
    const d = new LoopDetector({ threshold: 3 });
    const base = {
      tool: "browser.click",
      args: { ref: "e10" },
      resultSummary: "clicked ref=e10",
    } as const;
    expect(d.observe({ ...base, worldDigest: "w1" }).kind).toBe("ok");
    expect(d.observe({ ...base, worldDigest: "w2" }).kind).toBe("ok");
    expect(d.observe({ ...base, worldDigest: "w3" }).kind).toBe("ok");
  });

  it("does not fire when args differ even if tool and result match", () => {
    const d = new LoopDetector({ threshold: 3 });
    expect(
      d.observe({
        tool: "browser.click",
        args: { ref: "e1" },
        resultSummary: "clicked",
        worldDigest: "w",
      }).kind,
    ).toBe("ok");
    expect(
      d.observe({
        tool: "browser.click",
        args: { ref: "e2" },
        resultSummary: "clicked",
        worldDigest: "w",
      }).kind,
    ).toBe("ok");
    expect(
      d.observe({
        tool: "browser.click",
        args: { ref: "e3" },
        resultSummary: "clicked",
        worldDigest: "w",
      }).kind,
    ).toBe("ok");
  });

  it("treats object args with reordered keys as identical", () => {
    const d = new LoopDetector({ threshold: 3 });
    expect(
      d.observe({
        tool: "t",
        args: { a: 1, b: 2 },
        resultSummary: "ok",
        worldDigest: null,
      }).kind,
    ).toBe("ok");
    expect(
      d.observe({
        tool: "t",
        args: { b: 2, a: 1 },
        resultSummary: "ok",
        worldDigest: null,
      }).kind,
    ).toBe("ok");
    expect(
      d.observe({
        tool: "t",
        args: { a: 1, b: 2 },
        resultSummary: "ok",
        worldDigest: null,
      }).kind,
    ).toBe("repeat");
  });

  it("resets run counter after firing so next repeat needs threshold again", () => {
    const d = new LoopDetector({ threshold: 3 });
    const step = {
      tool: "x",
      args: {},
      resultSummary: "s",
      worldDigest: "w",
    };
    expect(d.observe(step).kind).toBe("ok");
    expect(d.observe(step).kind).toBe("ok");
    expect(d.observe(step).kind).toBe("repeat");
    expect(d.observe(step).kind).toBe("ok");
    expect(d.observe(step).kind).toBe("ok");
    expect(d.observe(step).kind).toBe("repeat");
  });
});

describe("formatRepeatNotice", () => {
  it("mentions tool name and count", () => {
    const notice = formatRepeatNotice({ tool: "browser.click", count: 5 });
    expect(notice).toContain("browser.click");
    expect(notice).toContain("5 times");
  });
});
