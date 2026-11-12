import { describe, expect, it } from "vitest";

import type { PersonaResolution } from "../config/agent/persona-resolve.js";
import { PersonaLatch } from "./persona-latch.js";

const reviewer: PersonaResolution = {
  source: "active",
  requested: "reviewer",
  persona: { name: "reviewer", instructions: "Review first." },
};
const writer: PersonaResolution = {
  source: "active",
  requested: "writer",
  persona: { name: "writer", instructions: "Plain English." },
};

describe("PersonaLatch", () => {
  it("keeps a session's first persona after the config changes", () => {
    const latch = new PersonaLatch();
    let current = reviewer;
    expect(latch.resolve("s1", () => current)).toBe(reviewer);
    current = writer;
    expect(latch.resolve("s1", () => current)).toBe(reviewer);
    expect(latch.peek("s1")).toBe(reviewer);
  });

  it("gives a new session the persona configured now", () => {
    const latch = new PersonaLatch();
    latch.resolve("s1", () => reviewer);
    expect(latch.resolve("s2", () => writer)).toBe(writer);
    expect(latch.peek("s3")).toBeUndefined();
  });

  it("latches `no persona` too, so a later switch does not add a block mid-session", () => {
    const latch = new PersonaLatch();
    latch.resolve("s1", () => ({ source: "none" }));
    expect(latch.resolve("s1", () => writer).persona).toBeUndefined();
  });
});
