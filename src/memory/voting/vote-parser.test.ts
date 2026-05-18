import { describe, expect, it } from "vitest";

import { parseVoteOutput, type VoteAllowlist } from "./vote-parser.js";

function allowlist(
  memory: number[] = [],
  lesson: number[] = [],
  profile: number[] = [],
): VoteAllowlist {
  return {
    memory: new Set(memory),
    lesson: new Set(lesson),
    profile: new Set(profile),
  };
}

describe("parseVoteOutput", () => {
  it("treats empty input as none", () => {
    expect(parseVoteOutput("", { allowlist: allowlist() })).toEqual({
      kind: "none",
    });
    expect(parseVoteOutput("   ", { allowlist: allowlist() })).toEqual({
      kind: "none",
    });
    expect(parseVoteOutput("NONE", { allowlist: allowlist() })).toEqual({
      kind: "none",
    });
    expect(parseVoteOutput("none\n", { allowlist: allowlist() })).toEqual({
      kind: "none",
    });
  });

  it("parses a single upvote into +1 direction", () => {
    const out = parseVoteOutput("UPVOTE lesson:42\n", {
      allowlist: allowlist([], [42]),
    });
    expect(out).toEqual({
      kind: "votes",
      votes: [{ kind: "lesson", targetId: 42, direction: 1 }],
      rejected: [],
    });
  });

  it("parses a single downvote into -1 direction", () => {
    const out = parseVoteOutput("DOWNVOTE memory:7\n", {
      allowlist: allowlist([7]),
    });
    expect(out).toEqual({
      kind: "votes",
      votes: [{ kind: "memory", targetId: 7, direction: -1 }],
      rejected: [],
    });
  });

  it("parses multiple votes in order", () => {
    const out = parseVoteOutput(
      [
        "UPVOTE memory:1",
        "DOWNVOTE lesson:2",
        "UPVOTE profile:3",
      ].join("\n"),
      { allowlist: allowlist([1], [2], [3]) },
    );
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([
        { kind: "memory", targetId: 1, direction: 1 },
        { kind: "lesson", targetId: 2, direction: -1 },
        { kind: "profile", targetId: 3, direction: 1 },
      ]);
      expect(out.rejected).toEqual([]);
    }
  });

  // Scorecard 7a.B — invariant 18. Surfaced allowlist is the load-bearing
  // anti-feedback-loop guard.
  it("rejects votes against non-surfaced ids (scorecard 7a.B / invariant 18)", () => {
    const out = parseVoteOutput("UPVOTE lesson:9999\n", {
      allowlist: allowlist([], [1, 2, 3]),
    });
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([]);
      expect(out.rejected).toEqual([
        {
          raw: "UPVOTE lesson:9999",
          reason: "not_surfaced",
          kind: "lesson",
          targetId: 9999,
        },
      ]);
    }
  });

  it("rejects votes whose kind is unsurfaced even if the id is surfaced under another kind", () => {
    // id 42 is surfaced as a memory but the vote claims lesson:42.
    const out = parseVoteOutput("UPVOTE lesson:42\n", {
      allowlist: allowlist([42], [], []),
    });
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([]);
      expect(out.rejected[0]?.reason).toBe("not_surfaced");
    }
  });

  it("drops malformed lines without failing the rest", () => {
    const out = parseVoteOutput(
      [
        "UPVOTE memory:1",
        "GIBBERISH lesson",
        "UPVOTE memory:abc", // non-numeric id
        "UPVOTE unknown:5", // unknown kind
        "DOWNVOTE lesson:2",
      ].join("\n"),
      { allowlist: allowlist([1], [2]) },
    );
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([
        { kind: "memory", targetId: 1, direction: 1 },
        { kind: "lesson", targetId: 2, direction: -1 },
      ]);
      const reasons = out.rejected.map((r) => r.reason).sort();
      expect(reasons).toEqual(["malformed", "malformed", "malformed"]);
    }
  });

  it("deduplicates (kind, id) pairs within a single payload — first wins", () => {
    const out = parseVoteOutput(
      [
        "UPVOTE memory:5",
        "DOWNVOTE memory:5",
      ].join("\n"),
      { allowlist: allowlist([5]) },
    );
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([
        { kind: "memory", targetId: 5, direction: 1 },
      ]);
      expect(out.rejected).toEqual([
        {
          raw: "DOWNVOTE memory:5",
          reason: "duplicate",
          kind: "memory",
          targetId: 5,
        },
      ]);
    }
  });

  it("enforces maxVotes cap after allowlist filtering", () => {
    const ids = [1, 2, 3, 4, 5];
    const lines = ids.map((i) => `UPVOTE memory:${i}`).join("\n");
    const out = parseVoteOutput(lines, {
      allowlist: allowlist(ids),
      maxVotes: 3,
    });
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes.map((v) => v.targetId)).toEqual([1, 2, 3]);
      expect(out.rejected.map((r) => r.reason)).toEqual([
        "cap_exceeded",
        "cap_exceeded",
      ]);
    }
  });

  it("returns none when every line is rejected as malformed and no votes survive", () => {
    const out = parseVoteOutput("GIBBERISH\nMORE GIBBERISH\n", {
      allowlist: allowlist(),
    });
    // Has rejections (so we return "votes" + rejection details for trace).
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([]);
      expect(out.rejected).toHaveLength(2);
    }
  });

  it("treats id=0 as malformed (positive integer required)", () => {
    const out = parseVoteOutput("UPVOTE memory:0\n", {
      allowlist: allowlist([0]),
    });
    expect(out.kind).toBe("votes");
    if (out.kind === "votes") {
      expect(out.votes).toEqual([]);
      expect(out.rejected[0]?.reason).toBe("malformed");
    }
  });
});
