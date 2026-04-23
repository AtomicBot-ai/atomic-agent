import { describe, it, expect } from "vitest";

import { renderProfileSection } from "./profile-renderer.js";
import type { ProfileFact } from "./profile-store.js";

const pinned = (
  key: string,
  value: string,
  updatedAt = 1,
): ProfileFact => ({
  key,
  value,
  updatedAt,
  pinned: true,
  keywords: [],
});

const contextual = (
  key: string,
  value: string,
  keywords: string[],
  updatedAt = 1,
): ProfileFact => ({
  key,
  value,
  updatedAt,
  pinned: false,
  keywords,
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
});
