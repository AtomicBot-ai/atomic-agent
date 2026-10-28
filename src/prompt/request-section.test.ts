import { describe, expect, it } from "vitest";
import {
  assistantReplyTurn,
  assistantToolCallTurn,
  stoppedTurnMarker,
  toolResultTurn,
  userTurn,
} from "../session/conversation-turn.js";
import {
  NO_OPERATOR_WORDS_MARKER,
  ORIGINAL_REQUEST_BEGIN_MARKER,
  ORIGINAL_REQUEST_END_MARKER,
  previousReplyText,
  requestWords,
  workerRequestRecord,
} from "./request-section.js";

/** ATO-860: what the input guard reads out of a turn's record. */
describe("request words for the input guard", () => {
  it("reads a plain request as both names and consent", () => {
    expect(requestWords("Clean sales.csv")).toEqual({
      names: "Clean sales.csv",
      consent: "Clean sales.csv",
    });
  });

  it("reads a worker brief's ORIGINAL REQUEST block as both", () => {
    const brief = `TASK t1\n${ORIGINAL_REQUEST_BEGIN_MARKER}\nClean sales.csv\n${ORIGINAL_REQUEST_END_MARKER}\nRewrite notes.md`;
    expect(workerRequestRecord(brief)).toBe(brief);
    const words = requestWords(workerRequestRecord(brief));
    expect(words.names.trim()).toBe("Clean sales.csv");
    expect(words.consent).toBe(words.names);
  });

  it("keeps a block-less worker brief's names but none of its words as consent", () => {
    const brief = "TASK t1: Rewrite sales.csv with the clean rows";
    const record = workerRequestRecord(brief);
    expect(record.startsWith(NO_OPERATOR_WORDS_MARKER)).toBe(true);
    const words = requestWords(record);
    expect(words.names).toContain("Rewrite sales.csv");
    expect(words.consent).toBe("");
  });
});

describe("previousReplyText", () => {
  it("is the last reply of the previous turn, read back past its tool rows", () => {
    expect(
      previousReplyText([
        userTurn("Clean sales.csv"),
        assistantToolCallTurn({ tool: "os.fs.read", args: { path: "sales.csv" } }),
        toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "..." }),
        assistantReplyTurn("Replace sales.csv?"),
      ]),
    ).toBe("Replace sales.csv?");
  });

  it("is nothing after a user row, a stopped turn, or only a progress note", () => {
    expect(previousReplyText([])).toBeUndefined();
    expect(
      previousReplyText([assistantReplyTurn("Replace sales.csv?"), userTurn("wait")]),
    ).toBeUndefined();
    expect(
      previousReplyText([assistantReplyTurn("Replace sales.csv?"), userTurn("go"), stoppedTurnMarker()]),
    ).toBeUndefined();
    expect(
      previousReplyText([
        userTurn("Clean sales.csv"),
        assistantReplyTurn("Replace sales.csv?", { progressNote: true }),
        toolResultTurn({ tool: "os.fs.read", status: "ok", summary: "..." }),
      ]),
    ).toBeUndefined();
  });
});
