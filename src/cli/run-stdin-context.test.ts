import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { joinPromptWithStdin, readStdinContext } from "./run-stdin-context.js";

/** ATO-2440: piped stdin joins the prompt argument. */
describe("run stdin context", () => {
  it("reads a pipe to its end", async () => {
    const read = await readStdinContext(Readable.from(["a\n", "b\n"]));
    expect(read).toEqual({ text: "a\nb\n", truncated: false, consumed: true });
  });

  it("leaves a silent pipe unread for the approval reader", async () => {
    const silent = new PassThrough();
    const read = await readStdinContext(silent, { waitMs: 10 });
    expect(read).toEqual({ text: "", truncated: false, consumed: false });
    // A line written later is still there for the next reader.
    silent.write("y\n");
    expect(String(silent.read())).toBe("y\n");
  });

  it("cuts at the byte cap", async () => {
    const read = await readStdinContext(Readable.from(["abcdef"]), { maxBytes: 4 });
    expect(read).toEqual({ text: "abcd", truncated: true, consumed: true });
  });

  it("puts the piped text after the prompt in a stdin block", () => {
    expect(joinPromptWithStdin("explain", { text: "log line\n\n", truncated: false, consumed: true })).toBe(
      "explain\n\n<stdin>\nlog line\n</stdin>",
    );
    expect(joinPromptWithStdin("explain", { text: "  \n", truncated: false, consumed: true })).toBe("explain");
    expect(joinPromptWithStdin("x", { text: "y", truncated: true, consumed: true })).toContain("[stdin was cut at");
  });
});
