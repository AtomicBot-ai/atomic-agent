import { describe, expect, it } from "vitest";

import { AuthThrottle } from "./auth-throttle.js";

describe("AuthThrottle (ATO-1126)", () => {
  it("blocks an address after the tenth wrong key in a minute, for a minute", () => {
    let t = 0;
    const th = new AuthThrottle({ now: () => t });
    for (let i = 0; i < 9; i++) th.failed("192.168.1.30");
    expect(th.retryAfter("192.168.1.30")).toBe(0);
    th.failed("192.168.1.30");
    expect(th.retryAfter("192.168.1.30")).toBe(60);
    t = 61_000;
    expect(th.retryAfter("192.168.1.30")).toBe(0);
  });

  it("forgets failures spread wider than the window, and on a right key", () => {
    let t = 0;
    const th = new AuthThrottle({ now: () => t });
    for (let i = 0; i < 9; i++) { th.failed("10.0.0.5"); t += 10_000; }
    th.failed("10.0.0.5");
    expect(th.retryAfter("10.0.0.5")).toBe(0);
    th.succeeded("10.0.0.5");
    for (let i = 0; i < 9; i++) th.failed("10.0.0.5");
    expect(th.retryAfter("10.0.0.5")).toBe(0);
  });

  it("never blocks loopback", () => {
    const th = new AuthThrottle();
    for (let i = 0; i < 50; i++) { th.failed("127.0.0.1"); th.failed("::ffff:127.0.0.1"); th.failed("::1"); }
    expect(th.retryAfter("127.0.0.1")).toBe(0);
    expect(th.retryAfter("::1")).toBe(0);
  });
});
