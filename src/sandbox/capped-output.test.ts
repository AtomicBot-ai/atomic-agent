import { describe, expect, it } from "vitest";

import { CappedOutput } from "./capped-output.js";

describe("CappedOutput", () => {
  it("keeps everything under the cap verbatim", () => {
    const out = new CappedOutput(100);
    out.append(Buffer.from("hello "));
    out.append(Buffer.from("world"));
    expect(out.snapshot()).toEqual({
      text: "hello world",
      bytes: 11,
      droppedBytes: 0,
      truncated: false,
    });
  });

  it("keeps the head and the newest tail, dropping the middle with a marker", () => {
    // Cap 40 with a quarter for the head: 10 bytes of head, 30 of tail.
    const out = new CappedOutput(40, 0.25);
    for (let i = 0; i < 10; i += 1) out.append(Buffer.from(`line${i}\n`));
    const snap = out.snapshot();
    expect(snap.bytes).toBe(60);
    expect(snap.droppedBytes).toBe(20);
    expect(snap.truncated).toBe(true);
    expect(snap.text.startsWith("line0\nline")).toBe(true);
    expect(snap.text).toContain("… [20 bytes dropped]");
    expect(snap.text.endsWith("line5\nline6\nline7\nline8\nline9\n")).toBe(true);
  });

  it("trims a single chunk larger than the tail to its newest bytes", () => {
    const out = new CappedOutput(8, 0);
    out.append(Buffer.from("0123456789abcdef"));
    const snap = out.snapshot();
    expect(snap.text.endsWith("89abcdef")).toBe(true);
    expect(snap.droppedBytes).toBe(8);
  });
});
