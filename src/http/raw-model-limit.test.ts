import { describe, expect, it } from "vitest";

import { createInFlightLimit, DEFAULT_RAW_MODEL_MAX_IN_FLIGHT } from "./raw-model-limit.js";

describe("createInFlightLimit (ATO-2336)", () => {
  it("lets one request in by default and the next one after it is released", () => {
    expect(DEFAULT_RAW_MODEL_MAX_IN_FLIGHT).toBe(1);
    const limit = createInFlightLimit();
    const release = limit.tryAcquire();
    expect(release).not.toBeNull();
    expect(limit.tryAcquire()).toBeNull();
    expect(limit.inFlight).toBe(1);
    release?.();
    expect(limit.inFlight).toBe(0);
    expect(limit.tryAcquire()).not.toBeNull();
  });

  it("does not free a second place when one release is called twice", () => {
    const limit = createInFlightLimit(2);
    const a = limit.tryAcquire();
    limit.tryAcquire();
    a?.();
    a?.();
    expect(limit.inFlight).toBe(1);
  });
});
