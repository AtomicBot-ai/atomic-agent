import { describe, expect, it } from "vitest";

import { mentionsAgent, stripAgentMention } from "./linear-mention.js";
import { readLinearMentions } from "./linear-types.js";

const HANDLES = ["agent"];

describe("mentionsAgent", () => {
  it("finds a plain @handle anywhere in the comment, any case", () => {
    expect(mentionsAgent("@agent please triage", HANDLES)).toBe(true);
    expect(mentionsAgent("Hey @Agent, can you look?", HANDLES)).toBe(true);
    expect(mentionsAgent("line one\n@agent.", HANDLES)).toBe(true);
  });

  it("finds a Linear profile link mention", () => {
    expect(mentionsAgent("[@Atomic Agent](https://linear.app/acme/profiles/agent) look", HANDLES)).toBe(true);
    expect(mentionsAgent("cc https://linear.app/acme/profiles/agent", HANDLES)).toBe(true);
  });

  it("ignores emails, longer handles and comments without a mention", () => {
    expect(mentionsAgent("mail me@agent.dev", HANDLES)).toBe(false);
    expect(mentionsAgent("@agents are cool", HANDLES)).toBe(false);
    expect(mentionsAgent("@agent.dev", HANDLES)).toBe(false);
    expect(mentionsAgent("the agent should do this", HANDLES)).toBe(false);
    expect(mentionsAgent("https://linear.app/acme/profiles/agentsmith", HANDLES)).toBe(false);
  });

  it("matches any configured handle", () => {
    const handles = readLinearMentions({ mention: "@Atomic, bot" });
    expect(handles).toEqual(["atomic", "bot"]);
    expect(mentionsAgent("@bot go", handles)).toBe(true);
    expect(mentionsAgent("@agent go", handles)).toBe(false);
  });
});

describe("stripAgentMention", () => {
  it("leaves only the request", () => {
    expect(stripAgentMention("@agent please triage this", HANDLES)).toBe("please triage this");
    expect(stripAgentMention("@agent, summarize", HANDLES)).toBe("summarize");
    expect(stripAgentMention("[@Atomic Agent](https://linear.app/acme/profiles/agent) fix the bug", HANDLES)).toBe(
      "fix the bug",
    );
  });

  it("keeps line breaks of a multi-line request", () => {
    expect(stripAgentMention("@agent do this:\n- one\n- two", HANDLES)).toBe("do this:\n- one\n- two");
  });
});

describe("readLinearMentions", () => {
  it("defaults to agent and drops invalid handles", () => {
    expect(readLinearMentions({})).toEqual(["agent"]);
    expect(readLinearMentions({ mention: "  , !!" })).toEqual(["agent"]);
  });
});
