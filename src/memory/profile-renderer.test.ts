import { describe, it, expect } from "vitest";

import { renderProfileSection } from "./profile-renderer.js";
import type { ProfileFact } from "./profile-store.js";

const pinned = (
  key: string,
  value: string,
  updatedAt = 1,
  voteScore = 0,
): ProfileFact => ({
  key,
  value,
  updatedAt,
  pinned: true,
  keywords: [],
  voteScore,
});

const contextual = (
  key: string,
  value: string,
  keywords: string[],
  updatedAt = 1,
  voteScore = 0,
): ProfileFact => ({
  key,
  value,
  updatedAt,
  pinned: false,
  keywords,
  voteScore,
});

describe("renderProfileSection", () => {
  it("returns the sentinel when empty", () => {
    expect(renderProfileSection([])).toBe("(no profile)");
  });

  it("emits pinned facts sorted alphabetically by key", () => {
    const out = renderProfileSection([
      pinned("timezone", "UTC"),
      pinned("language", "ru"),
      pinned("name", "Alex"),
    ]);
    expect(out).toBe(
      [
        "- language: ru",
        "- name: Alex",
        "- timezone: UTC",
      ].join("\n"),
    );
  });

  it("collapses multi-line values into single prompt lines", () => {
    const out = renderProfileSection([
      pinned("note", "first line\nsecond line\r\nthird"),
    ]);
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain(" \\n ");
  });

  it("suppresses contextual facts when no user message is provided", () => {
    const out = renderProfileSection([
      pinned("language", "ru"),
      contextual("deploy_cmd", "pnpm run deploy", ["deploy", "release"]),
    ]);
    expect(out).toBe("- language: ru");
  });

  it("includes contextual facts when a keyword hits the user message", () => {
    const out = renderProfileSection(
      [
        pinned("language", "ru"),
        contextual("deploy_cmd", "pnpm run deploy", ["deploy", "release"]),
      ],
      { userMessage: "How do I deploy this branch?" },
    );
    expect(out).toBe(
      ["- deploy_cmd: pnpm run deploy", "- language: ru"].join("\n"),
    );
  });

  it("matches keywords as whole words (case-insensitive)", () => {
    const msg = "Run the CI pipeline please.";
    const out = renderProfileSection(
      [contextual("ci_url", "https://ci.example", ["ci"])],
      { userMessage: msg },
    );
    expect(out).toBe("- ci_url: https://ci.example");
    const noHit = renderProfileSection(
      [contextual("ci_url", "https://ci.example", ["ci"])],
      { userMessage: "I want to disciple myself" },
    );
    expect(noHit).toBe("(no profile)");
  });

  it("returns the sentinel when gate suppresses all facts", () => {
    const out = renderProfileSection(
      [contextual("deploy_cmd", "pnpm run deploy", ["deploy"])],
      { userMessage: "hello world" },
    );
    expect(out).toBe("(no profile)");
  });

  it("disabling the gate renders every fact regardless of pinned/keywords", () => {
    const out = renderProfileSection(
      [
        pinned("language", "ru"),
        contextual("deploy_cmd", "pnpm run deploy", ["deploy"]),
      ],
      { contextualKeywordGate: false },
    );
    expect(out).toBe(
      ["- deploy_cmd: pnpm run deploy", "- language: ru"].join("\n"),
    );
  });

  // Phase 7a — vote-score suppression. The renderer hides facts the
  // operator has actively downvoted past a configurable threshold,
  // **regardless** of pinned/keyword status. The threshold is
  // strictly positive; a value of 0 / undefined leaves the legacy
  // behaviour intact.
  it("hides a contextual fact whose vote_score is below the negative threshold", () => {
    const out = renderProfileSection(
      [
        pinned("language", "ru"),
        contextual("deploy_cmd", "pnpm run deploy", ["deploy"], 1, -3),
      ],
      {
        userMessage: "How do I deploy this?",
        profileFilterThreshold: 2,
      },
    );
    expect(out).toBe("- language: ru");
  });

  it("hides a pinned fact too when its vote_score is past the threshold", () => {
    const out = renderProfileSection(
      [
        pinned("language", "ru", 1, -5),
        pinned("name", "Alex"),
      ],
      { profileFilterThreshold: 3 },
    );
    expect(out).toBe("- name: Alex");
  });

  it("uses strict <= for the threshold so the boundary value is also hidden", () => {
    const out = renderProfileSection(
      [pinned("language", "ru", 1, -2), pinned("name", "Alex")],
      { profileFilterThreshold: 2 },
    );
    expect(out).toBe("- name: Alex");
  });

  it("renders facts above the threshold unchanged", () => {
    const out = renderProfileSection(
      [pinned("language", "ru", 1, -1), pinned("name", "Alex")],
      { profileFilterThreshold: 3 },
    );
    expect(out).toBe(
      ["- language: ru", "- name: Alex"].join("\n"),
    );
  });

  it("threshold=0 disables the filter (back-compat)", () => {
    const out = renderProfileSection(
      [pinned("language", "ru", 1, -99)],
      { profileFilterThreshold: 0 },
    );
    expect(out).toBe("- language: ru");
  });

  it("threshold=undefined disables the filter (back-compat)", () => {
    const out = renderProfileSection([
      pinned("language", "ru", 1, -99),
    ]);
    expect(out).toBe("- language: ru");
  });
});
