import { describe, expect, it } from "vitest";
import { mergeToolName } from "./openai-stream-consumer.js";

/**
 * Reported as "Anthropic models do not work at all", with:
 *
 *   Turn failed [tool]: tool not registered in this agent:
 *   replyreplyreplyreplyreplyreplyreplyreplyreplyreplyreply
 *
 * Arguments stream as fragments and concatenate. A *name* does not —
 * the OpenAI contract sends it once, whole — so the accumulator
 * appended, which is right for every provider that follows the
 * contract and catastrophic for the ones that repeat the full name in
 * every delta. The turn died naming a tool nobody had written.
 */
describe("mergeToolName", () => {
  it("takes the first name", () => {
    expect(mergeToolName("", "reply")).toBe("reply");
  });

  it("drops a repeat of the whole name", () => {
    expect(mergeToolName("reply", "reply")).toBe("reply");
  });

  it("survives the reported stream verbatim", () => {
    // Eleven deltas, each carrying the full name.
    let name = "";
    for (let i = 0; i < 11; i++) name = mergeToolName(name, "reply");
    expect(name).toBe("reply");
  });

  it("still joins genuine fragments", () => {
    // A provider that really does split the name must keep working:
    // the two cases are distinguishable and both are served.
    expect(mergeToolName("os.fs", ".read")).toBe("os.fs.read");
    expect(mergeToolName("re", "ply")).toBe("reply");
  });

  it("repairs a name that was already doubled before a repeat", () => {
    expect(mergeToolName("replyreply", "reply")).toBe("replyreply");
  });

  it("does not mistake a fragment for a repeat", () => {
    // `read` is not a repeat of `os.fs.` — appending is correct.
    expect(mergeToolName("os.fs.", "read")).toBe("os.fs.read");
  });
});
