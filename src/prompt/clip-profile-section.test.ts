import { describe, expect, it } from "vitest";

import type { ProfileFact } from "../memory/profile-store.js";

import { clipProfileSection } from "./clip-profile-section.js";
import { estimateTokens } from "./token-budget.js";

/**
 * Issue #407. The `### profile` clip keeps or drops whole fact lines,
 * pinned facts last to go, and reports what it left out.
 */

let nextId = 1;
function fact(
  key: string,
  value: string,
  pinned: boolean,
  keywords: string[] = [],
): ProfileFact {
  return {
    id: nextId++,
    key,
    value,
    validFrom: 1,
    updatedAt: 1,
    pinned,
    keywords,
    supersedes: null,
    supersededBy: null,
    voteScore: 0,
  };
}
const pinned = (key: string, value: string): ProfileFact =>
  fact(key, value, true);
const contextual = (
  key: string,
  value: string,
  keywords: string[],
): ProfileFact => fact(key, value, false, keywords);

const marker = (count: number): string =>
  `… [truncated] ${count} more profile ${count === 1 ? "fact" : "facts"} not shown (memory.profile.maxTokens)`;

describe("clipProfileSection", () => {
  it("returns the whole section and no clip when it fits", () => {
    const out = clipProfileSection(
      [pinned("name", "Alex"), pinned("language", "ru")],
      { maxTokens: 512 },
    );
    expect(out.text).toBe("- language: ru\n- name: Alex");
    expect(out.clip).toBeUndefined();
  });

  it("returns the sentinel, unclipped, when no fact is selected", () => {
    const out = clipProfileSection(
      [contextual("deploy_cmd", "pnpm run deploy", ["deploy"])],
      { userMessage: "hello", maxTokens: 512 },
    );
    expect(out).toEqual({ text: "(no profile)" });
  });

  it("leaves contextual facts out before pinned ones when the budget is tight", () => {
    // The contextual keys sort first: the old key-ordered render put them
    // ahead of the pinned facts, and the clip cut the pinned tail.
    const facts = [
      contextual("a_deploy", "pnpm run deploy --prod --region eu-west-1", [
        "deploy",
      ]),
      contextual("b_release", "tag and push the release branch", ["deploy"]),
      pinned("y_consent", "never share the owner's files without asking"),
      pinned("z_security", "never run destructive commands outside the repo"),
    ];
    const pinnedLines = [
      "- y_consent: never share the owner's files without asking",
      "- z_security: never run destructive commands outside the repo",
    ];
    const maxTokens = estimateTokens([...pinnedLines, marker(2)].join("\n"));

    const out = clipProfileSection(facts, {
      userMessage: "deploy it",
      maxTokens,
    });

    expect(out.text).toBe([...pinnedLines, marker(2)].join("\n"));
    expect(out.clip).toEqual({
      rendered: 2,
      dropped: 2,
      pinnedDropped: 0,
      maxTokens,
    });
  });

  it("never cuts a line: what is kept is whole rendered facts plus the marker", () => {
    const facts = Array.from({ length: 40 }, (_, i) =>
      pinned(`key_${String(i).padStart(2, "0")}`, `value number ${i} `.repeat(3)),
    );
    const rendered = facts.map((f) => `- ${f.key}: ${f.value}`);

    const out = clipProfileSection(facts, { maxTokens: 120 });

    const lines = out.text.split("\n");
    const last = lines.pop();
    expect(out.clip).toBeDefined();
    const clip = out.clip!;
    expect(last).toBe(marker(clip.dropped));
    expect(lines).toHaveLength(clip.rendered);
    for (const line of lines) expect(rendered).toContain(line);
    expect(clip.rendered).toBeGreaterThan(0);
    expect(clip.rendered + clip.dropped).toBe(40);
    expect(clip.pinnedDropped).toBe(clip.dropped);
    expect(estimateTokens(out.text)).toBeLessThanOrEqual(120);
  });

  it("skips one fact too long for the budget and keeps the shorter ones behind it", () => {
    const out = clipProfileSection(
      [
        pinned("a_blob", "x".repeat(1_500)),
        pinned("b_name", "Alex"),
        pinned("c_tz", "UTC"),
      ],
      { maxTokens: 60 },
    );
    expect(out.text).toBe(
      ["- b_name: Alex", "- c_tz: UTC", marker(1)].join("\n"),
    );
    expect(out.clip).toEqual({
      rendered: 2,
      dropped: 1,
      pinnedDropped: 1,
      maxTokens: 60,
    });
  });

  it("renders nothing rather than a partial marker when even the marker does not fit", () => {
    const out = clipProfileSection([pinned("name", "x".repeat(400))], {
      maxTokens: 5,
    });
    expect(out.text).toBe("");
    expect(out.clip).toEqual({
      rendered: 0,
      dropped: 1,
      pinnedDropped: 1,
      maxTokens: 5,
    });
  });

  it("stays within the budget for any input (the packer's arithmetic is estimateTokens')", () => {
    let seed = 7;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 300; round += 1) {
      const n = 1 + Math.floor(rand() * 30);
      const facts = Array.from({ length: n }, (_, i) => {
        const words = Array.from({ length: 1 + Math.floor(rand() * 25) }, () =>
          "w".repeat(1 + Math.floor(rand() * 12)),
        );
        const gap = rand() < 0.3 ? "  \t " : " ";
        const tail = rand() < 0.2 ? "   " : "";
        return fact(`k${i}`, words.join(gap) + tail, rand() < 0.6);
      });
      const maxTokens = 1 + Math.floor(rand() * 300);
      const out = clipProfileSection(facts, {
        contextualKeywordGate: false,
        maxTokens,
      });
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(maxTokens);
      if (out.clip !== undefined) {
        expect(out.clip.rendered + out.clip.dropped).toBe(n);
        expect(out.clip.dropped).toBeGreaterThan(0);
      }
    }
  });

  it("is deterministic", () => {
    const facts = Array.from({ length: 30 }, (_, i) =>
      fact(`k${i}`, `some value ${i} `.repeat(4), i % 3 !== 0, ["x"]),
    );
    const a = clipProfileSection(facts, { userMessage: "x", maxTokens: 90 });
    const b = clipProfileSection(facts, { userMessage: "x", maxTokens: 90 });
    expect(a).toEqual(b);
  });
});
