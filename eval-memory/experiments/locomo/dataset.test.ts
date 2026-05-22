import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCOMO_CATEGORY_LABELS,
  LocomoDatasetError,
  loadLocomoDataset,
  renderConversationPrompts,
  type LocomoConversation,
} from "./dataset.js";

function writeTempLocomo(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "locomo-test-"));
  const path = join(dir, "locomo.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return path;
}

const SAMPLE_CONVERSATION = [
  {
    sample_id: "conv-1",
    conversation: {
      speaker_a: "Alice",
      speaker_b: "Bob",
      session_1_date_time: "2024-05-01 09:00",
      session_1: [
        { speaker: "Alice", text: "Hi Bob, how was Lisbon?" },
        { speaker: "Bob", text: "Loved the pasteis. Stayed at hotel Avenida." },
      ],
      session_2_date_time: "2024-06-10 11:00",
      session_2: [
        { speaker: "Alice", text: "Are you going back?" },
        { speaker: "Bob", text: "Booked for September." },
      ],
    },
    qa: [
      {
        question: "Where did Bob stay in Lisbon?",
        answer: "Hotel Avenida",
        category: 1,
        evidence: ["D1:T2"],
        adversarial_answer: null,
      },
      {
        question: "When did Bob discuss returning to Lisbon?",
        answer: "Around June 2024",
        category: 3,
        evidence: ["D2"],
      },
      {
        question: "What did Bob eat on Mars?",
        answer: "Not mentioned",
        category: 5,
        adversarial_answer: "Not mentioned",
        evidence: [],
      },
    ],
  },
];

describe("loadLocomoDataset", () => {
  it("normalises the canonical locomo10.json shape", () => {
    const path = writeTempLocomo(SAMPLE_CONVERSATION);
    try {
      const convs = loadLocomoDataset({ path });
      expect(convs).toHaveLength(1);
      const conv = convs[0]!;
      expect(conv.sampleId).toBe("conv-1");
      expect(conv.speakerA).toBe("Alice");
      expect(conv.sessions).toHaveLength(2);
      expect(conv.sessions[0]!.id).toBe("session_1");
      expect(conv.sessions[0]!.dateTime).toBe("2024-05-01 09:00");
      expect(conv.sessions[0]!.turns).toHaveLength(2);
      expect(conv.qa).toHaveLength(3);
      const adv = conv.qa.find((q) => q.category === 5)!;
      expect(adv.categoryLabel).toBe("adversarial");
      expect(adv.adversarialAnswer).toBe("Not mentioned");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("throws when the file is missing", () => {
    expect(() => loadLocomoDataset({ path: "/tmp/does-not-exist.json" })).toThrow(
      LocomoDatasetError,
    );
  });

  it("throws when the file is empty / malformed", () => {
    const path = writeTempLocomo([]);
    try {
      expect(() => loadLocomoDataset({ path })).toThrow(LocomoDatasetError);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("skips QA entries with unknown category id", () => {
    const path = writeTempLocomo([
      {
        sample_id: "c2",
        conversation: {
          speaker_a: "A",
          speaker_b: "B",
          session_1: [{ speaker: "A", text: "hi" }],
        },
        qa: [
          { question: "good?", answer: "yes", category: 1, evidence: [] },
          { question: "bad?", answer: "no", category: 99, evidence: [] },
        ],
      },
    ]);
    try {
      const convs = loadLocomoDataset({ path });
      expect(convs[0]!.qa).toHaveLength(1);
      expect(convs[0]!.qa[0]!.category).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("LOCOMO_CATEGORY_LABELS", () => {
  it("covers all five LoCoMo categories", () => {
    expect(LOCOMO_CATEGORY_LABELS[1]).toBe("single_hop");
    expect(LOCOMO_CATEGORY_LABELS[2]).toBe("multi_hop");
    expect(LOCOMO_CATEGORY_LABELS[3]).toBe("temporal");
    expect(LOCOMO_CATEGORY_LABELS[4]).toBe("open_domain");
    expect(LOCOMO_CATEGORY_LABELS[5]).toBe("adversarial");
  });
});

describe("renderConversationPrompts", () => {
  it("returns one prompt per session with the date-time header", () => {
    const conv: LocomoConversation = loadLocomoDataset({
      path: writeTempLocomo(SAMPLE_CONVERSATION),
    })[0]!;
    const prompts = renderConversationPrompts(conv);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("[session_1 — 2024-05-01 09:00]");
    expect(prompts[0]).toContain("Bob: Loved the pasteis");
  });
});
