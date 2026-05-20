import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LONGMEMEVAL_AXES,
  LongMemEvalDatasetError,
  loadLongMemEvalDataset,
  renderHaystackPrompts,
} from "./dataset.js";

function writeTemp(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "lme-test-"));
  const path = join(dir, "longmemeval_s.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return path;
}

const SAMPLE = [
  {
    question_id: "q1",
    question_type: "single-session-user",
    question: "Where did Bob stay?",
    answer: "Hotel Avenida",
    haystack_sessions: [
      [
        { role: "user", content: "Tell me about Lisbon." },
        { role: "assistant", content: "Bob stayed at Hotel Avenida." },
      ],
    ],
    answer_session_ids: ["0"],
  },
  {
    question_id: "q2",
    question_type: "multi-session",
    question: "When did Bob return?",
    answer: "September",
    haystack_sessions: [
      [
        { role: "user", content: "Trip plan?" },
        { role: "assistant", content: "Booked for September." },
      ],
      [{ role: "user", content: "Side note." }],
    ],
    answer_session_ids: ["0"],
  },
  {
    question_id: "q3",
    question_type: "knowledge-update",
    question: "Latest job title?",
    answer: "Lead",
    is_abstention: false,
    haystack_sessions: [
      [{ role: "assistant", content: "Promoted to Lead." }],
    ],
  },
  {
    question_id: "q4",
    question_type: "single-session-user",
    question: "Mars café?",
    answer: "",
    is_abstention: true,
    haystack_sessions: [
      [{ role: "user", content: "Earth chat." }],
    ],
  },
];

describe("loadLongMemEvalDataset", () => {
  it("maps question_type onto the five canonical axes", () => {
    const path = writeTemp(SAMPLE);
    try {
      const rows = loadLongMemEvalDataset({ path });
      expect(rows.map((r) => r.axis)).toEqual([
        "information_extraction",
        "multi_session_reasoning",
        "knowledge_updates",
        "abstention",
      ]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("preserves answer_session_ids and is_abstention", () => {
    const path = writeTemp(SAMPLE);
    try {
      const rows = loadLongMemEvalDataset({ path });
      const abst = rows.find((r) => r.questionId === "q4")!;
      expect(abst.isAbstention).toBe(true);
      expect(abst.axis).toBe("abstention");
      const multi = rows.find((r) => r.questionId === "q2")!;
      expect(multi.answerSessionIds).toEqual(["0"]);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("throws when the file is missing", () => {
    expect(() =>
      loadLongMemEvalDataset({ path: "/tmp/does-not-exist.json" }),
    ).toThrow(LongMemEvalDatasetError);
  });

  it("drops rows with an empty haystack", () => {
    const path = writeTemp([
      {
        question_id: "bad",
        question_type: "single-session-user",
        question: "?",
        answer: "x",
        haystack_sessions: [],
      },
      {
        question_id: "good",
        question_type: "single-session-user",
        question: "?",
        answer: "x",
        haystack_sessions: [[{ role: "user", content: "hi" }]],
      },
    ]);
    try {
      const rows = loadLongMemEvalDataset({ path });
      expect(rows.map((r) => r.questionId)).toEqual(["good"]);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

describe("LONGMEMEVAL_AXES", () => {
  it("lists the five axes from PLAN.md Phase 3", () => {
    expect(LONGMEMEVAL_AXES).toEqual([
      "information_extraction",
      "multi_session_reasoning",
      "temporal_reasoning",
      "knowledge_updates",
      "abstention",
    ]);
  });
});

describe("renderHaystackPrompts", () => {
  it("produces one prompt per session with a session header", () => {
    const path = writeTemp(SAMPLE);
    try {
      const rows = loadLongMemEvalDataset({ path });
      const prompts = renderHaystackPrompts(rows[1]!); // multi-session row
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("[session_1]");
      expect(prompts[0]).toContain("Booked for September");
    } finally {
      rmSync(path, { force: true });
    }
  });
});
