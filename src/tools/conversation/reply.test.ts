import { describe, expect, it } from "vitest";
import { replyTool } from "./reply.js";

const ctx = {
  workingDir: "/tmp",
  sessionId: "s-1",
  stepIndex: 0,
  signal: new AbortController().signal,
};

describe("replyTool", () => {
  it("returns an ok result with the text marked terminal=turn", async () => {
    const out = await replyTool.run({ text: "hello there" }, ctx);
    expect(out.status).toBe("ok");
    expect(out.summary).toContain("hello there");
    expect(out.details).toMatchObject({
      text: "hello there",
      terminal: "turn",
    });
  });

  it("rejects missing or empty text", async () => {
    await expect(replyTool.run({}, ctx)).rejects.toThrow(/non-empty string/);
    await expect(replyTool.run({ text: "" }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
  });

  it("rejects non-string text", async () => {
    await expect(replyTool.run({ text: 42 }, ctx)).rejects.toThrow(
      /non-empty string/,
    );
  });
});
