import { describe, expect, it } from "vitest";

import { findDuplicateFact, normaliseProfileValue } from "./profile-duplicates.js";
import type { ProfileFact } from "./profile-store.js";

let nextId = 1;
function fact(key: string, value: string): ProfileFact {
  return {
    id: nextId++,
    key,
    value,
    validFrom: 0,
    updatedAt: 0,
    pinned: true,
    keywords: [],
    supersedes: null,
    supersededBy: null,
    voteScore: 0,
    nameGrounding: null,
  };
}

// ATO-188: the same fact landed twice — `name = Надя` as two versions,
// and `prefers_short_answers = yes` beside `response_length_preference = short`.
describe("findDuplicateFact", () => {
  it("finds the same value under the same key, case and punctuation aside", () => {
    const stored = [fact("name", "Надя"), fact("timezone", "Europe/Lisbon")];
    expect(findDuplicateFact(stored, "name", "Надя")?.kind).toBe("same");
    expect(findDuplicateFact(stored, "name", " надя. ")?.kind).toBe("same");
    expect(findDuplicateFact(stored, "timezone", "UTC")).toBeNull();
  });

  it("finds the same name under another name key", () => {
    const stored = [fact("name", "Надя")];
    expect(findDuplicateFact(stored, "first_name", "Надя")).toMatchObject({
      kind: "near",
      fact: { key: "name" },
    });
    expect(findDuplicateFact(stored, "first_name", "Аня")).toBeNull();
  });

  it("finds the same preference under a differently worded key", () => {
    const stored = [fact("prefers_short_answers", "yes")];
    expect(findDuplicateFact(stored, "response_length_preference", "short")?.kind).toBe("near");
    expect(findDuplicateFact(stored, "reply_style", "brief replies")?.kind).toBe("near");
    const lang = [fact("language", "ru")];
    expect(findDuplicateFact(lang, "preferred_language", "ru")?.kind).toBe("near");
  });

  it("does not call a contradiction or a different fact a duplicate", () => {
    const stored = [
      fact("prefers_short_answers", "yes"),
      fact("likes_cats", "yes"),
      fact("deploy_command", "make ship"),
    ];
    expect(findDuplicateFact(stored, "prefers_short_answers_in_chat", "no")).toBeNull();
    expect(findDuplicateFact(stored, "response_length_preference", "long")).toBeNull();
    expect(findDuplicateFact(stored, "likes_dogs", "yes")).toBeNull();
    expect(findDuplicateFact(stored, "build_command", "make build")).toBeNull();
    expect(findDuplicateFact(stored, "home_city", "Lisbon")).toBeNull();
    // Adding to a fact is not repeating it.
    expect(findDuplicateFact([fact("language", "ru")], "language_learning", "ru en")).toBeNull();
    expect(findDuplicateFact([fact("language", "ru")], "language_learning", "ru")).toBeNull();
  });
});

describe("normaliseProfileValue", () => {
  it("ignores case, inner spacing and trailing punctuation only", () => {
    expect(normaliseProfileValue("  Europe/Lisbon. ")).toBe("europe/lisbon");
    expect(normaliseProfileValue("make   ship")).toBe("make ship");
    expect(normaliseProfileValue("v1.2")).toBe("v1.2");
  });
});
