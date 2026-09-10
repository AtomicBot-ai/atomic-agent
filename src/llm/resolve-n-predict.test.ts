import { describe, expect, it } from "vitest";

import { resolveNPredict } from "./llama-server-client.js";

describe("resolveNPredict", () => {
  it("passes a configured cap straight through", () => {
    expect(resolveNPredict(undefined, 8192)).toBe(8192);
  });

  it("lets one call override the configured cap", () => {
    expect(resolveNPredict(256, 8192)).toBe(256);
  });

  it("turns a configured 0 into llama.cpp's -1 — generate until stop or context", () => {
    expect(resolveNPredict(undefined, 0)).toBe(-1);
  });

  it("turns an explicit per-call 0 into -1 as well", () => {
    expect(resolveNPredict(0, 8192)).toBe(-1);
  });
});
