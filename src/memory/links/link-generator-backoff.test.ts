import { describe, expect, it } from "vitest";

import { createLinkGeneratorBackoff } from "./link-generator-backoff.js";

describe("createLinkGeneratorBackoff", () => {
  it("lets every call run until a timeout happens", () => {
    const b = createLinkGeneratorBackoff();
    expect(b.take("s1")).toBe(0);
    expect(b.take("s1")).toBe(0);
  });

  it("skips the next baseCalls calls after a timeout, then runs again", () => {
    const b = createLinkGeneratorBackoff({ baseCalls: 2 });
    expect(b.onTimeout("s1")).toBe(2);
    expect(b.take("s1")).toBe(2);
    expect(b.take("s1")).toBe(1);
    expect(b.take("s1")).toBe(0);
  });

  it("doubles the window on consecutive timeouts, capped at maxCalls", () => {
    const b = createLinkGeneratorBackoff({ baseCalls: 3, maxCalls: 10 });
    expect(b.onTimeout("s1")).toBe(3);
    expect(b.onTimeout("s1")).toBe(6);
    expect(b.onTimeout("s1")).toBe(10);
    expect(b.onTimeout("s1")).toBe(10);
  });

  it("resets after a healthy call", () => {
    const b = createLinkGeneratorBackoff({ baseCalls: 3 });
    b.onTimeout("s1");
    b.onTimeout("s1");
    b.onHealthy("s1");
    expect(b.take("s1")).toBe(0);
    expect(b.onTimeout("s1")).toBe(3);
  });

  it("keeps sessions independent", () => {
    const b = createLinkGeneratorBackoff({ baseCalls: 1 });
    b.onTimeout("s1");
    expect(b.take("s2")).toBe(0);
    expect(b.take("s1")).toBe(1);
  });

  it("baseCalls 0 turns the backoff off", () => {
    const b = createLinkGeneratorBackoff({ baseCalls: 0 });
    expect(b.onTimeout("s1")).toBe(0);
    expect(b.take("s1")).toBe(0);
  });
});
