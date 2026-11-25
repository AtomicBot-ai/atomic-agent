import { describe, expect, it } from "vitest";
import { encodeIterm2Inline } from "./iterm2-inline.js";

describe("encodeIterm2Inline", () => {
  it("wraps the file in OSC 1337 with size and cell box", () => {
    const bytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const seq = encodeIterm2Inline(bytes, { cols: 20, rows: 6, name: "a.png" });
    expect(seq.startsWith("\u001b]1337;File=")).toBe(true);
    expect(seq.endsWith("\u0007")).toBe(true);
    expect(seq).toContain(`name=${Buffer.from("a.png").toString("base64")}`);
    expect(seq).toContain("size=4;width=20;height=6;preserveAspectRatio=1;inline=1:");
    const payload = seq.slice(seq.indexOf(":") + 1, -1);
    expect(Buffer.from(payload, "base64")).toEqual(Buffer.from(bytes));
  });

  it("omits the name when none is given", () => {
    expect(encodeIterm2Inline(new Uint8Array(1), { cols: 1, rows: 1 })).not.toContain("name=");
  });
});
