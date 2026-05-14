import { describe, expect, it } from "vitest";
import { createWheelAccelerator } from "./wheel-accelerator.js";

describe("WheelAccelerator", () => {
  it("returns the base delta on the first notch", () => {
    let now = 1_000;
    const accel = createWheelAccelerator({
      baseDelta: 1,
      now: () => now,
    });
    expect(accel.next(1)).toBe(1);
  });

  it("ramps up the multiplier when consecutive notches arrive in the accel window", () => {
    let now = 0;
    const accel = createWheelAccelerator({
      baseDelta: 1,
      accelWindowMs: 120,
      accelStep: 2,
      maxMultiplier: 8,
      now: () => now,
    });
    expect(accel.next(1)).toBe(1);
    now += 50;
    expect(accel.next(1)).toBe(2);
    now += 50;
    expect(accel.next(1)).toBe(4);
    now += 50;
    expect(accel.next(1)).toBe(8);
    now += 50;
    expect(accel.next(1)).toBe(8);
  });

  it("resets the multiplier when the gap exceeds the accel window", () => {
    let now = 0;
    const accel = createWheelAccelerator({
      baseDelta: 1,
      accelWindowMs: 100,
      accelStep: 2,
      now: () => now,
    });
    expect(accel.next(1)).toBe(1);
    now += 50;
    expect(accel.next(1)).toBe(2);
    now += 500;
    expect(accel.next(1)).toBe(1);
  });

  it("resets on direction change", () => {
    let now = 0;
    const accel = createWheelAccelerator({
      baseDelta: 1,
      accelWindowMs: 100,
      accelStep: 2,
      now: () => now,
    });
    expect(accel.next(1)).toBe(1);
    now += 50;
    expect(accel.next(1)).toBe(2);
    now += 50;
    expect(accel.next(-1)).toBe(-1);
  });

  it("emits negative deltas for downward scroll preserving magnitude", () => {
    let now = 0;
    const accel = createWheelAccelerator({
      baseDelta: 2,
      accelWindowMs: 100,
      accelStep: 1.5,
      now: () => now,
    });
    expect(accel.next(-1)).toBe(-2);
    now += 50;
    expect(accel.next(-1)).toBe(-3);
  });

  it("manual reset() clears the multiplier", () => {
    let now = 0;
    const accel = createWheelAccelerator({
      baseDelta: 1,
      accelWindowMs: 100,
      accelStep: 2,
      now: () => now,
    });
    accel.next(1);
    now += 50;
    expect(accel.next(1)).toBe(2);
    accel.reset();
    now += 50;
    expect(accel.next(1)).toBe(1);
  });
});
