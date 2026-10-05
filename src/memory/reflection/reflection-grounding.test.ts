import { describe, expect, it } from "vitest";

import {
  filterUngroundedReflection,
  isNameProfileKey,
  isTrivialReflectionWindow,
} from "./reflection-grounding.js";
import type { ReflectionFact, ReflectionNote } from "./reflection-parser.js";

function fact(key: string, value: string): ReflectionFact {
  return { key, value, pinned: true, keywords: [], supersedes: null, validFrom: null };
}

function note(body: string, tags: string[] = []): ReflectionNote {
  return { body, tags };
}

/** The exact prompt from the B09 tester report (desktop 02.10, Qwen 3.5 4B). */
const B09_PROMPT = "Reply exactly LOCAL_OK. Do not use tools.";

/** The two notes reflection stored for that session. */
const B09_NOTES = [
  note("I am Alex and you are my personal assistant. You should remember me as Alex."),
  note(
    "I prefer using local_ok instead of tools. This is important because I want to avoid tool usage.",
  ),
];

describe("isTrivialReflectionWindow", () => {
  it("B09: treats 'Reply exactly LOCAL_OK. Do not use tools.' as a trivial window", () => {
    expect(isTrivialReflectionWindow([B09_PROMPT])).toBe(true);
  });

  it("treats pings, greetings and acknowledgements as trivial", () => {
    expect(isTrivialReflectionWindow(["hi"])).toBe(true);
    expect(isTrivialReflectionWindow(["Привет!"])).toBe(true);
    expect(isTrivialReflectionWindow(["ok thanks"])).toBe(true);
    expect(isTrivialReflectionWindow(["ping"])).toBe(true);
    expect(isTrivialReflectionWindow([""])).toBe(true);
  });

  it("treats other echo / one-off probe phrasings as trivial", () => {
    expect(isTrivialReflectionWindow(["Respond with exactly: PONG"])).toBe(true);
    expect(isTrivialReflectionWindow(["Say 'ready' and nothing else."])).toBe(true);
    expect(isTrivialReflectionWindow(["Ответь только ОК. Не используй инструменты."])).toBe(
      true,
    );
    expect(isTrivialReflectionWindow(["Reply exactly OK, no explanation"])).toBe(true);
  });

  it("does not treat a substantive message as trivial", () => {
    expect(isTrivialReflectionWindow(["What is the capital of France?"])).toBe(false);
    expect(isTrivialReflectionWindow(["Reply exactly LOCAL_OK. Also, what is 2+2?"])).toBe(
      false,
    );
  });

  it("does not treat a lasting style rule as trivial", () => {
    // "only in Russian" is a style rule, not an echo payload.
    expect(isTrivialReflectionWindow(["Reply only in Russian"])).toBe(false);
    expect(isTrivialReflectionWindow(["Answer in Russian from now on"])).toBe(false);
    expect(isTrivialReflectionWindow(["Never use tools unless I ask"])).toBe(false);
    expect(isTrivialReflectionWindow(["Remember: do not use tools"])).toBe(false);
  });

  it("does not treat a message about the user as trivial", () => {
    expect(isTrivialReflectionWindow(["My name is Nadia"])).toBe(false);
    expect(isTrivialReflectionWindow(["Меня зовут Надя"])).toBe(false);
  });

  it("is non-trivial when any message of a multi-turn window is substantive", () => {
    expect(isTrivialReflectionWindow(["hi", "remember I prefer TypeScript"])).toBe(false);
    expect(isTrivialReflectionWindow(["hi", B09_PROMPT])).toBe(true);
  });
});

describe("filterUngroundedReflection", () => {
  it("B09: drops both invented notes from the LOCAL_OK session", () => {
    const out = filterUngroundedReflection(
      { facts: [fact("name", "Alex")], notes: B09_NOTES },
      { userTexts: [B09_PROMPT] },
    );
    expect(out.facts).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.dropped.map((d) => d.kind).sort()).toEqual(["fact", "note", "note"]);
    const factDrop = out.dropped.find((d) => d.kind === "fact");
    expect(factDrop?.reason).toBe("ungrounded_identity");
    const localOkDrop = out.dropped.find((d) => d.text.includes("local_ok"));
    expect(localOkDrop?.reason).toBe("one_off_payload");
  });

  it("drops an identity claim whose name the user never wrote", () => {
    const out = filterUngroundedReflection(
      {
        facts: [fact("name", "Alex"), fact("full_name", "Alex Smith")],
        notes: [note("The user is Alex."), note("I am Alex.")],
      },
      { userTexts: ["Can you summarise this article about Rust?"] },
    );
    expect(out.facts).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(new Set(out.dropped.map((d) => d.reason))).toEqual(
      new Set(["ungrounded_identity"]),
    );
  });

  it("drops the assistant describing itself", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("You are my personal assistant."), note("I am an AI assistant.")] },
      { userTexts: ["Summarise the release notes for v0.6.5"] },
    );
    expect(out.notes).toEqual([]);
    expect(out.dropped.every((d) => d.reason === "assistant_persona")).toBe(true);
  });

  it("keeps a legit 'my name is Nadia' + 'remember I prefer TypeScript' session", () => {
    const facts = [fact("name", "Nadia"), fact("language_preference", "TypeScript")];
    const notes = [note("The user prefers TypeScript for new projects.", ["lang"])];
    const userTexts = ["My name is Nadia.", "Remember that I prefer TypeScript for new projects."];
    expect(isTrivialReflectionWindow(userTexts)).toBe(false);
    const out = filterUngroundedReflection({ facts, notes }, { userTexts });
    expect(out.facts).toEqual(facts);
    expect(out.notes).toEqual(notes);
    expect(out.dropped).toEqual([]);
  });

  it("keeps a name the user wrote in Cyrillic and the model romanised", () => {
    const out = filterUngroundedReflection(
      {
        facts: [fact("name", "Nadya")],
        notes: [note("The user's name is Nadia.")],
      },
      { userTexts: ["Меня зовут Надя, запомни это"] },
    );
    expect(out.facts.map((f) => f.value)).toEqual(["Nadya"]);
    expect(out.notes).toHaveLength(1);
  });

  it("treats a name already stored in the profile as grounded", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("I am Nadia and I moved to Lisbon.")] },
      { userTexts: ["I moved to Lisbon last week, remember that"], knownNames: ["Nadia"] },
    );
    expect(out.notes).toHaveLength(1);
  });

  it("does not mistake 'I am an assistant professor' for the assistant persona", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("I am an assistant professor at MIT.")] },
      { userTexts: ["I'm an assistant professor at MIT, remember that."] },
    );
    expect(out.notes).toHaveLength(1);
  });

  it("fails open on identity when the user wrote in a script it cannot compare", () => {
    const out = filterUngroundedReflection(
      { facts: [fact("name", "Xiaoming")], notes: [] },
      { userTexts: ["我叫小明，请记住"] },
    );
    expect(out.facts).toHaveLength(1);
  });

  it("drops a one-off tool restriction promoted to a preference", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("The user prefers not to use tools.")] },
      { userTexts: ["Do not use tools. What is 17 * 23?"] },
    );
    expect(out.notes).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("one_off_tool_restriction");
  });

  it("keeps a tool preference the user said should last", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("The user wants the agent to never use tools unless asked.")] },
      { userTexts: ["From now on, never use tools unless I ask."] },
    );
    expect(out.notes).toHaveLength(1);
  });

  it("does not treat an echo payload as one-off when the user also uses it elsewhere", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("The user's API follows the JSON:API spec.")] },
      { userTexts: ["Reply with only JSON. Our API follows the JSON:API spec, remember that."] },
    );
    expect(out.notes).toHaveLength(1);
  });

  it("leaves ordinary facts and notes untouched", () => {
    const facts = [fact("timezone", "Europe/Lisbon"), fact("deploy_command", "make ship")];
    const notes = [note("staging flyway migrations need FLYWAY_BASELINE=1 or deploy fails")];
    const out = filterUngroundedReflection(
      { facts, notes },
      { userTexts: ["We deploy with make ship; staging needs FLYWAY_BASELINE=1. I'm in Lisbon."] },
    );
    expect(out.facts).toEqual(facts);
    expect(out.notes).toEqual(notes);
  });
});

describe("isNameProfileKey", () => {
  it("recognises name-like keys and nothing else", () => {
    for (const key of ["name", "full_name", "first_name", "user_name", "nickname", "username"]) {
      expect(isNameProfileKey(key)).toBe(true);
    }
    for (const key of ["timezone", "project_name_style", "language", "deploy_command"]) {
      expect(isNameProfileKey(key)).toBe(false);
    }
  });
});
