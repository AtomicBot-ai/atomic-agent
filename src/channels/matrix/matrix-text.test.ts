import { describe, expect, it } from "vitest";

import {
  matrixSenderLine,
  sanitizeMatrixId,
  stripBotMention,
  stripReplyFallback,
} from "./matrix-text.js";

describe("stripReplyFallback", () => {
  const reply = { "m.relates_to": { "m.in_reply_to": { event_id: "$e" } } };

  it("drops the quoted original of a reply", () => {
    expect(stripReplyFallback("> <@bob:x> old words\n> more\n\nnew request", reply)).toBe(
      "new request",
    );
  });

  it("leaves a message that is not a reply alone, even with quotes", () => {
    expect(stripReplyFallback("> quoted\n\ntext", {})).toBe("> quoted\n\ntext");
  });
});

describe("stripBotMention", () => {
  it("removes a leading mxid or localpart address", () => {
    expect(stripBotMention("@bot:example.org: list files", "@bot:example.org")).toBe("list files");
    expect(stripBotMention("bot: list files", "@bot:example.org")).toBe("list files");
  });

  it("keeps a mention in the middle", () => {
    expect(stripBotMention("ask bot: later", "@bot:example.org")).toBe("ask bot: later");
  });
});

describe("matrixSenderLine", () => {
  it("renders readable mxids and room ids", () => {
    expect(matrixSenderLine("@ada:example.org", "!room:example.org")).toBe(
      "[from] platform=matrix user=@ada:example.org chat=!room:example.org",
    );
  });

  it("cannot be broken out of with spaces or quotes", () => {
    expect(sanitizeMatrixId('@a b"c\n:x')).toBe("@abc:x");
  });
});
