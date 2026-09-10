import { describe, expect, it } from "vitest";

import { readReplyAttachments } from "./step-executor.js";

describe("readReplyAttachments", () => {
  it("returns the string entries of a reply result's attachments", () => {
    expect(
      readReplyAttachments({
        text: "x",
        terminal: "turn",
        attachments: ["/tmp/a.pdf", "/tmp/b.png"],
      }),
    ).toEqual(["/tmp/a.pdf", "/tmp/b.png"]);
  });

  it("projects a missing, malformed or legacy result to no attachments", () => {
    expect(readReplyAttachments(undefined)).toEqual([]);
    expect(readReplyAttachments({ text: "x", terminal: "turn" })).toEqual([]);
    expect(readReplyAttachments({ attachments: "/tmp/a.pdf" })).toEqual([]);
    expect(readReplyAttachments({ attachments: [1, "", "/ok"] })).toEqual([
      "/ok",
    ]);
  });
});
