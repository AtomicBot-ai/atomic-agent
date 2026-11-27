import { describe, expect, it, vi } from "vitest";

import { createLocalNameDetector, splitParagraphs, type LocalNameModel } from "./local-name-detector.js";
import { PrivacyVault } from "./privacy-vault.js";

const RU = "Звонил Иван Петров, его почта ivan.petrov@mail.ru, телефон +7 912 345-67-89.";
const EN = "Please send the contract to John Smith at 221B Baker Street, London. Copy jane@example.com.";

type Reply = (user: string) => string | Promise<string>;

function fakeModel(reply: Reply, local = true): { model: LocalNameModel; users: string[] } {
  const users: string[] = [];
  const model: LocalNameModel = {
    id: "fake-local",
    local,
    async complete({ user }) {
      users.push(user);
      return reply(user);
    },
  };
  return { model, users };
}

const answer = (spans: { text: string; kind: string }[]): string => JSON.stringify({ spans });

/** What today's shield sends: a fresh vault, regex masks only. */
const regexOnly = (text: string): string => new PrivacyVault().mask(text);

describe("local name detector (ATO-2394)", () => {
  it("adds names to the regex masks, in Russian", async () => {
    const { model } = fakeModel(() => answer([{ text: "Иван Петров", kind: "NAME" }]));
    const detector = createLocalNameDetector({ model: () => model });
    const vault = new PrivacyVault();
    vault.learn(await detector.detect(() => [RU]));
    expect(vault.mask(RU)).toBe("Звонил [NAME_1], его почта [EMAIL_1], телефон [PHONE_1].");
  });

  it("adds names and street addresses, in English", async () => {
    const { model } = fakeModel(() =>
      answer([
        { text: "John Smith", kind: "NAME" },
        { text: "221B Baker Street", kind: "ADDRESS" },
      ]),
    );
    const detector = createLocalNameDetector({ model: () => model });
    const vault = new PrivacyVault();
    vault.learn(await detector.detect(() => [EN]));
    expect(vault.mask(EN)).toBe("Please send the contract to [NAME_1] at [ADDRESS_1], London. Copy [EMAIL_1].");
  });

  it("drops a span the text does not contain word for word", async () => {
    const { model } = fakeModel(() =>
      answer([
        { text: "Пётр Сидоров", kind: "NAME" },
        { text: "иван петров", kind: "NAME" },
        { text: "Иван Петров", kind: "NAME" },
      ]),
    );
    const detector = createLocalNameDetector({ model: () => model });
    const found = await detector.detect(() => [RU]);
    expect(found).toEqual([{ value: "Иван Петров", kind: "NAME" }]);
  });

  it("drops a span that only exists across two paragraphs of one call", async () => {
    const { model } = fakeModel(() => answer([{ text: "Smith\n\nBaker", kind: "NAME" }, { text: "Smith Baker", kind: "NAME" }]));
    const detector = createLocalNameDetector({ model: () => model });
    expect(await detector.detect(() => ["Mr Smith", "Baker Street"])).toEqual([]);
  });

  it.each([
    ["the model throws", () => Promise.reject(new Error("engine down"))],
    ["the reply is not JSON", () => "Sure! The names are Иван Петров and John Smith."],
    ["the reply has the wrong shape", () => JSON.stringify({ names: ["John Smith"] })],
  ])("falls back to the regex result when %s", async (_label, reply) => {
    const onError = vi.fn();
    const { model } = fakeModel(reply as Reply);
    const detector = createLocalNameDetector({ model: () => model, onError });
    const found = await detector.detect(() => [RU, EN]);
    expect(found).toEqual([]);
    expect(onError).toHaveBeenCalled();
    const vault = new PrivacyVault();
    vault.learn(found);
    expect(vault.mask(RU)).toBe(regexOnly(RU));
    expect(vault.mask(EN)).toBe(regexOnly(EN));
  });

  it("falls back to the regex result on a timeout, even when the model ignores the signal", async () => {
    const { model } = fakeModel(() => new Promise<string>(() => undefined));
    const detector = createLocalNameDetector({ model: () => model, timeoutMs: 20 });
    const found = await detector.detect(() => [EN]);
    expect(found).toEqual([]);
    const vault = new PrivacyVault();
    vault.learn(found);
    expect(vault.mask(EN)).toBe(regexOnly(EN));
  });

  it("does not call the model once the caller has cancelled", async () => {
    const { model, users } = fakeModel(() => answer([{ text: "John Smith", kind: "NAME" }]));
    const detector = createLocalNameDetector({ model: () => model });
    expect(await detector.detect(() => [EN], AbortSignal.abort())).toEqual([]);
    expect(users).toHaveLength(0);
  });

  it("refuses a model that is not local: nothing is read or sent", async () => {
    const { model, users } = fakeModel(() => answer([{ text: "John Smith", kind: "NAME" }]), false);
    const readTexts = vi.fn(() => [EN]);
    const detector = createLocalNameDetector({ model: () => model });
    expect(await detector.detect(readTexts)).toEqual([]);
    expect(users).toHaveLength(0);
    expect(readTexts).not.toHaveBeenCalled();
    expect(detector.calls).toBe(0);
  });

  it("does nothing without a model", async () => {
    const readTexts = vi.fn(() => [EN]);
    const detector = createLocalNameDetector({ model: () => null });
    expect(await detector.detect(readTexts)).toEqual([]);
    expect(readTexts).not.toHaveBeenCalled();
  });

  it("answers a paragraph it has seen from the cache, without a second call", async () => {
    const { model, users } = fakeModel(() => answer([{ text: "John Smith", kind: "NAME" }]));
    const detector = createLocalNameDetector({ model: () => model });
    const first = await detector.detect(() => [EN]);
    const second = await detector.detect(() => [EN]);
    expect(second).toEqual(first);
    expect(detector.calls).toBe(1);
    // A history that grew by one paragraph sends only the new one.
    await detector.detect(() => [`${EN}\n\nAnd Mary Jones too.`]);
    expect(detector.calls).toBe(2);
    expect(users[1]).toContain("Mary Jones");
    expect(users[1]).not.toContain("Baker Street");
  });

  it("does not cache a failed call, so the next request asks again", async () => {
    let fail = true;
    const { model } = fakeModel(() => (fail ? "not json" : answer([{ text: "John Smith", kind: "NAME" }])));
    const detector = createLocalNameDetector({ model: () => model });
    expect(await detector.detect(() => [EN])).toEqual([]);
    fail = false;
    expect(await detector.detect(() => [EN])).toEqual([{ value: "John Smith", kind: "NAME" }]);
    expect(detector.calls).toBe(2);
  });

  it("keeps the cache bounded", async () => {
    const { model } = fakeModel(() => answer([]));
    const detector = createLocalNameDetector({ model: () => model, cacheSize: 1 });
    await detector.detect(() => ["first paragraph"]);
    await detector.detect(() => ["second paragraph"]);
    await detector.detect(() => ["first paragraph"]);
    expect(detector.calls).toBe(3);
  });

  it("bounds the calls of one request", async () => {
    const { model } = fakeModel(() => answer([]));
    const detector = createLocalNameDetector({ model: () => model, maxChunkChars: 10, maxCallsPerDetect: 2 });
    await detector.detect(() => ["alpha one\n\nbravo two\n\ncharlie three\n\ndelta four"]);
    expect(detector.calls).toBe(2);
  });
});

describe("splitParagraphs", () => {
  it("splits on blank lines and skips pieces without a letter", () => {
    expect(splitParagraphs("Hello Anna\n\n  \n\n12345\n \nBye")).toEqual(["Hello Anna", "Bye"]);
  });
});
