import { describe, expect, it } from "vitest";

import type {
  GroundingConversation,
  GroundingConversationSource,
} from "./name-grounding.js";
import { createRecallNameGuard } from "./recall-name-guard.js";

/** Stored conversations made of these user messages, one per conversation. */
function sourceOf(userTexts: string[]): {
  source: GroundingConversationSource;
  walks: () => number;
} {
  let walks = 0;
  const source: GroundingConversationSource = async function* walk() {
    walks += 1;
    let updatedAt = 1_000;
    for (const text of userTexts) {
      const conversation: GroundingConversation = { updatedAt, texts: [text] };
      updatedAt -= 1;
      yield conversation;
    }
  };
  return { source, walks: () => walks };
}

describe("createRecallNameGuard (ATO-321)", () => {
  it("lets rows that claim no name through without any check", () => {
    const { source, walks } = sourceOf(["hello"]);
    const guard = createRecallNameGuard({ source });
    expect(guard.allows("User prefers dark mode in the editor")).toBe(true);
    expect(walks()).toBe(0);
  });

  it("holds out a name nobody typed after the check", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["fix the build please", "thanks"]).source,
    });
    const report = await guard.prefetch(["I am Alex and I like Rust"]);
    expect(report).toMatchObject({ names: 1, ungrounded: 1 });
    expect(guard.allows("I am Alex and I like Rust")).toBe(false);
    expect(guard.allows("The user is Alex.")).toBe(false);
  });

  it("lets a name the user did write through", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["hi, my name is Sam", "run the tests"]).source,
    });
    await guard.prefetch(["The user is Sam."]);
    expect(guard.allows("The user is Sam.")).toBe(true);
  });

  it("holds an unchecked name out and checks it in the background", async () => {
    const guard = createRecallNameGuard({ source: sourceOf(["I'm Sam"]).source });
    expect(guard.allows("The user is Sam.")).toBe(false);
    // The background check settles on its own; prefetch reuses it.
    await guard.prefetch(["The user is Sam."]);
    expect(guard.allows("The user is Sam.")).toBe(true);
  });

  it("checks each name once", async () => {
    const { source, walks } = sourceOf(["nothing here"]);
    const guard = createRecallNameGuard({ source });
    await guard.prefetch(["I am Alex.", "The user is Alex.", "I am Alex."]);
    guard.allows("I am Alex.");
    guard.allows("i am alex.");
    expect(walks()).toBe(1);
  });

  it("holds the row out when the check throws", async () => {
    const failing: GroundingConversationSource = () => ({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(new Error("db closed")),
        };
      },
    });
    const guard = createRecallNameGuard({ source: failing });
    const report = await guard.prefetch(["The user is Alex."]);
    expect(report.failed).toBe(1);
    expect(guard.allows("The user is Alex.")).toBe(false);
  });

  it("covers Russian notes too", async () => {
    const guard = createRecallNameGuard({
      source: sourceOf(["сделай макет для блока", "спасибо"]).source,
    });
    await guard.prefetch(["Пользователь Анна любит короткие ответы"]);
    expect(guard.allows("Пользователь Анна любит короткие ответы")).toBe(false);
  });
});
