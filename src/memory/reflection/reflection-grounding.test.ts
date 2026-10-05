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

  it("treats pings and greetings as trivial", () => {
    expect(isTrivialReflectionWindow(["hi"])).toBe(true);
    expect(isTrivialReflectionWindow(["Привет!"])).toBe(true);
    expect(isTrivialReflectionWindow(["thanks"])).toBe(true);
    expect(isTrivialReflectionWindow(["ping"])).toBe(true);
    expect(isTrivialReflectionWindow([""])).toBe(true);
  });

  // F7: a bare confirmation may answer "Shall I remember that you're
  // vegetarian?" — that turn must still be reflected.
  it("does not treat a bare confirmation as trivial", () => {
    for (const text of ["да", "нет", "ок", "хорошо", "yes", "no", "ok", "ok thanks"]) {
      expect(isTrivialReflectionWindow([text])).toBe(false);
    }
  });

  // F6: a style word after "only" is a lasting rule, not a literal echo.
  it("does not treat a non-literal 'reply only X' style rule as a probe", () => {
    expect(isTrivialReflectionWindow(["Отвечай только по-русски"])).toBe(false);
    expect(isTrivialReflectionWindow(["Answer only briefly"])).toBe(false);
    expect(isTrivialReflectionWindow(["Reply only English please"])).toBe(false);
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
        notes: [
          note("The user's name is Alex."),
          note("I am Alex."),
          note("I am Alex and I like Rust."),
          note("Call me Alex."),
          note("The user is Alex."),
        ],
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

// Regression cases from the adversarial review of the first B09 fix:
// every one of these is a real user fact the guard must keep (or, for
// F4 / F8, an invented one it must still drop).
describe("filterUngroundedReflection — review regressions", () => {
  const keepsName = (userText: string, name: string): void => {
    const out = filterUngroundedReflection(
      { facts: [fact("name", name)], notes: [] },
      { userTexts: [userText] },
    );
    expect(out.facts.map((f) => f.value)).toEqual([name]);
    expect(out.dropped).toEqual([]);
  };

  it("F1: keeps a name the user gave in a Russian case form", () => {
    keepsName("Зови меня Надей", "Nadya");
    keepsName("Называй меня Сашей", "Sasha");
    keepsName("Зови меня Алексом", "Alex");
    keepsName("звать меня Димой", "Dima");
  });

  it("F1: treats leading Е/Ye and Ю/Yu romanisations as the same name", () => {
    keepsName("Меня зовут Елена", "Yelena");
    keepsName("Я Евгений, запомни", "Yevgeny");
    keepsName("Меня зовут Юля", "Julia");
  });

  it("F2: keeps nationality / language attributes that are not names", () => {
    const out = filterUngroundedReflection(
      {
        facts: [],
        notes: [
          note("The user is Brazilian."),
          note("The user is Russian."),
          note("The user is Russian-speaking."),
        ],
      },
      { userTexts: ["I'm from Brazil, remember that", "Я из России"] },
    );
    expect(out.notes).toHaveLength(3);
  });

  it("F2: keeps 'I am <Attribute>' grounded by the root or the verbatim word", () => {
    const brazil = filterUngroundedReflection(
      { facts: [], notes: [note("I am Brazilian.")] },
      { userTexts: ["I'm from Brazil, remember that"] },
    );
    expect(brazil.notes).toHaveLength(1);
    const speaking = filterUngroundedReflection(
      { facts: [], notes: [note("I am Russian-speaking."), note("The user is Russian-speaking.")] },
      { userTexts: ["I am Russian-speaking"] },
    );
    expect(speaking.notes).toHaveLength(2);
  });

  it("F3: keeps facts the user asked to remember and plain preferences", () => {
    const deploy = filterUngroundedReflection(
      { facts: [fact("deploy_command", "make ship-prod")], notes: [] },
      { userTexts: ["Find the deploy command in the Makefile and remember it"] },
    );
    expect(deploy.facts).toHaveLength(1);
    const ts = filterUngroundedReflection(
      { facts: [fact("language_preference", "TypeScript")], notes: [] },
      { userTexts: ["I prefer TypeScript"] },
    );
    expect(ts.facts).toHaveLength(1);
    const meat = filterUngroundedReflection(
      { facts: [], notes: [note("The user does not eat meat.")] },
      { userTexts: ["я не ем мясо"] },
    );
    expect(meat.notes).toHaveLength(1);
  });

  it("F4: a pronoun does not make a one-off tool restriction last", () => {
    const userTexts = [
      "Reply exactly LOCAL_OK. Do not use tools, I'm testing the local model.",
    ];
    expect(isTrivialReflectionWindow(userTexts)).toBe(false);
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("The user prefers not to use tools.")] },
      { userTexts },
    );
    expect(out.notes).toEqual([]);
    expect(out.dropped[0]?.reason).toBe("one_off_tool_restriction");
  });

  it("F5: keeps an output-format preference the user said should last", () => {
    for (const userText of ["Запомни, отвечай только JSON", "From now on, reply only JSON"]) {
      const out = filterUngroundedReflection(
        { facts: [fact("reply_format", "JSON")], notes: [note("The user wants replies in JSON.")] },
        { userTexts: [userText] },
      );
      expect(out.facts).toHaveLength(1);
      expect(out.notes).toHaveLength(1);
    }
  });

  it("F8: a common lower-case word does not vouch for a short invented name", () => {
    const cases: Array<[string, string]> = [
      ["Sam", "it is the same as before"],
      ["Max", "make it so"],
      ["Anna", "and then rerun it"],
      ["Tom", "use the tool"],
      ["Ben", "it has been fixed"],
    ];
    for (const [name, userText] of cases) {
      const out = filterUngroundedReflection(
        { facts: [fact("name", name)], notes: [] },
        { userTexts: [userText] },
      );
      expect(out.facts).toEqual([]);
    }
  });

  it("F8: still keeps a short name the user typed, even in lower case", () => {
    keepsName("call me sam", "Sam");
  });

  it("N1: keeps 'works as an AI engineer'", () => {
    const out = filterUngroundedReflection(
      { facts: [], notes: [note("The user works as an AI engineer.")] },
      { userTexts: ["I'm an ML engineer on the AI team, remember that"] },
    );
    expect(out.notes).toHaveLength(1);
  });

  it("N2: drops contracted assistant-persona phrasings", () => {
    const out = filterUngroundedReflection(
      {
        facts: [],
        notes: [note("You're my personal assistant."), note("I'm your AI assistant.")],
      },
      { userTexts: ["Summarise the release notes"] },
    );
    expect(out.notes).toEqual([]);
    expect(out.dropped.every((d) => d.reason === "assistant_persona")).toBe(true);
  });

  it("N3: a stray foreign symbol does not switch the identity check off", () => {
    const out = filterUngroundedReflection(
      { facts: [fact("name", "Alex")], notes: [] },
      { userTexts: ["My name is Nadia, the dose is 5 µg"] },
    );
    expect(out.facts).toEqual([]);
  });
});

// Second review round.
describe("filterUngroundedReflection — re-review regressions", () => {
  const B09_TOOL_NOTE = B09_NOTES[1]!;

  it("R1: a marker elsewhere in the message does not lift a one-off probe", () => {
    const quick = filterUngroundedReflection(
      {
        facts: [],
        notes: [note("The user prefers not to use tools."), note("The user prefers quick answers.")],
      },
      { userTexts: ["Reply exactly OK, no tools, I prefer quick answers"] },
    );
    expect(quick.notes.map((n) => n.body)).toEqual(["The user prefers quick answers."]);
    expect(quick.dropped[0]?.reason).toBe("one_off_tool_restriction");

    for (const userText of [
      "Reply exactly LOCAL_OK. Do not use tools. I prefer short answers.",
      "Never mind. Reply exactly LOCAL_OK. Do not use tools.",
    ]) {
      const out = filterUngroundedReflection(
        { facts: [], notes: [B09_TOOL_NOTE] },
        { userTexts: [userText] },
      );
      expect(out.notes).toEqual([]);
      expect(out.dropped[0]?.reason).toBe("one_off_payload");
    }
  });

  it("R1: a marker-only clause right before the probe still makes it last", () => {
    for (const userText of ["Запомни, отвечай только JSON", "From now on, reply only JSON"]) {
      const out = filterUngroundedReflection(
        { facts: [fact("reply_format", "JSON")], notes: [note("The user wants replies in JSON.")] },
        { userTexts: [userText] },
      );
      expect(out.facts).toHaveLength(1);
      expect(out.notes).toHaveLength(1);
    }
    const tools = filterUngroundedReflection(
      { facts: [], notes: [note("The user does not want the agent to use tools.")] },
      { userTexts: ["Remember: do not use tools"] },
    );
    expect(tools.notes).toHaveLength(1);
  });

  it("R2: ordinary lower-case Russian words do not vouch for invented names", () => {
    const userText =
      "покажи данные по анализу и категории, сделай макет максимально быстро, маркетинг на март, никогда не трогай алерты";
    for (const name of ["Dan", "Anna", "Kate", "Max", "Mark", "Nick", "Alex"]) {
      const out = filterUngroundedReflection(
        { facts: [fact("name", name)], notes: [] },
        { userTexts: [userText] },
      );
      expect(out.facts).toEqual([]);
    }
  });

  it("R2: still grounds Russian names after a naming lead, even in lower case", () => {
    for (const [userText, name] of [
      ["зови меня надей", "Nadya"],
      ["Зови меня Надей", "Nadya"],
      ["называй меня сашей", "Sasha"],
      ["меня зовут дима", "Dima"],
    ] as const) {
      const out = filterUngroundedReflection(
        { facts: [fact("name", name)], notes: [] },
        { userTexts: [userText] },
      );
      expect(out.facts.map((f) => f.value)).toEqual([name]);
    }
  });

  it("R3: checks third-person 'The user is X.' but keeps demonyms", () => {
    const dropped = filterUngroundedReflection(
      { facts: [], notes: [note("The user is Alex."), note("The user is Alex and likes Rust.")] },
      { userTexts: ["Summarise this article about Rust"] },
    );
    expect(dropped.notes).toEqual([]);
    expect(dropped.dropped.every((d) => d.reason === "ungrounded_identity")).toBe(true);

    const kept = filterUngroundedReflection(
      {
        facts: [],
        notes: [
          note("The user is Brazilian."),
          note("The user is Russian."),
          note("The user is Russian-speaking."),
          note("The user is Nadia."),
        ],
      },
      { userTexts: ["I'm Nadia from Brazil"] },
    );
    expect(kept.notes).toHaveLength(4);
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
