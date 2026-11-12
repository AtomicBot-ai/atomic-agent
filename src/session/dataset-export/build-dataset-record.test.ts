import { describe, expect, it } from "vitest";

import { buildDatasetRecord } from "./build-dataset-record.js";

const same = (text: string): string => text;

describe("buildDatasetRecord (ATO-1104)", () => {
  it("turns chat lines into alternating user and assistant messages", () => {
    expect(
      buildDatasetRecord(
        [
          { kind: "user", text: "hi" },
          { kind: "assistant_reply", text: "hello" },
          { kind: "user", text: "fix the test" },
          { kind: "user", text: "  and the lint  " },
          { kind: "assistant_reply", text: "done" },
        ],
        same,
      ),
    ).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "fix the test\n\nand the lint" },
        { role: "assistant", content: "done" },
      ],
    });
  });

  it("opens on a question and closes on an answer", () => {
    expect(
      buildDatasetRecord(
        [
          { kind: "assistant_reply", text: "welcome back" },
          { kind: "user", text: "q" },
          { kind: "assistant_reply", text: "a" },
          { kind: "user", text: "unanswered" },
        ],
        same,
      )?.messages,
    ).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
  });

  it("gives no record for a chat without an answer or with only blank lines", () => {
    expect(buildDatasetRecord([{ kind: "user", text: "hello?" }], same)).toBeNull();
    expect(
      buildDatasetRecord(
        [
          { kind: "user", text: "  " },
          { kind: "assistant_reply", text: "" },
        ],
        same,
      ),
    ).toBeNull();
    expect(buildDatasetRecord([], same)).toBeNull();
  });

  it("runs every written message through the scrubber, and only those", () => {
    const seen: string[] = [];
    const record = buildDatasetRecord(
      [
        { kind: "user", text: "q" },
        { kind: "assistant_reply", text: "a" },
        { kind: "user", text: "dropped" },
      ],
      (text) => {
        seen.push(text);
        return text.toUpperCase();
      },
    );
    expect(seen).toEqual(["q", "a"]);
    expect(record?.messages.map((m) => m.content)).toEqual(["Q", "A"]);
  });
});
