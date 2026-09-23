import { describe, expect, it } from "vitest";

import { parseVoteOutput, type VoteAllowlist } from "./vote-parser.js";
import { VOTE_RESPONSE_FORMAT } from "./vote-response-format.js";

const allowlist: VoteAllowlist = {
  memory: new Set([42]),
  lesson: new Set(),
  profile: new Set(),
  procedure: new Set(),
};

describe("VOTE_RESPONSE_FORMAT under strict mode", () => {
  it("requires every top-level key, so OpenAI accepts the schema", () => {
    // With `votes` optional OpenAI refused every vote call with a 400
    // naming the missing key.
    const { schema } = VOTE_RESPONSE_FORMAT;
    expect(schema.required).toEqual(
      Object.keys(schema.properties as Record<string, unknown>),
    );
  });

  it("parses the strict abstain shape as none", () => {
    expect(
      parseVoteOutput(JSON.stringify({ kind: "none", votes: [] }), {
        allowlist,
      }),
    ).toEqual({ kind: "none" });
  });

  it("parses kind=votes with an empty array as none", () => {
    expect(
      parseVoteOutput(JSON.stringify({ kind: "votes", votes: [] }), {
        allowlist,
      }),
    ).toEqual({ kind: "none" });
  });

  it("ignores stray votes under kind=none", () => {
    const raw = JSON.stringify({
      kind: "none",
      votes: [{ target_kind: "memory", target_id: 42, direction: 1 }],
    });
    expect(parseVoteOutput(raw, { allowlist })).toEqual({ kind: "none" });
  });
});
