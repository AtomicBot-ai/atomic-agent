import type { Key } from "ink";
import { describe, expect, it } from "vitest";

import { handleProvidersWizardKey } from "./providers-wizard-key-bindings.js";
import { visibleKindRows } from "./providers-wizard-phases.js";
import { createProvidersWizardState } from "./providers-wizard-state.js";
import type { ProvidersWizardState } from "./providers-wizard-state.js";

function key(patch: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    home: false,
    end: false,
  } as Key & typeof patch;
}

/** Feed a string of printable characters through the wizard, one key each. */
function type(wizard: ProvidersWizardState, text: string): ProvidersWizardState {
  let current = wizard;
  for (const char of text) {
    const result = handleProvidersWizardKey(char, key(), current);
    if (!("wizard" in result)) throw new Error(`"${char}" did not update`);
    current = result.wizard;
  }
  return current;
}

function press(
  wizard: ProvidersWizardState,
  patch: Partial<Key>,
): ReturnType<typeof handleProvidersWizardKey> {
  return handleProvidersWizardKey("", { ...key(), ...patch }, wizard);
}

function providerList(): ProvidersWizardState {
  return createProvidersWizardState("add");
}

describe("the search box on the provider list", () => {
  it("starts closed, so j and k still move the cursor", () => {
    const wizard = providerList();
    expect(wizard.search).toBeNull();
    const moved = handleProvidersWizardKey("j", key(), wizard);
    expect("wizard" in moved && moved.wizard.cursor).toBe(1);
    expect("wizard" in moved && moved.wizard.search).toBeNull();
  });

  it("opens on / with an empty query and the cursor at the top", () => {
    const opened = handleProvidersWizardKey("/", key(), {
      ...providerList(),
      cursor: 7,
    });
    expect("wizard" in opened && opened.wizard.search).toBe("");
    expect("wizard" in opened && opened.wizard.cursor).toBe(0);
  });

  it("types j and k into the query instead of moving once it is open", () => {
    const typed = type(handleOpen(providerList()), "jk");
    expect(typed.search).toBe("jk");
    expect(typed.cursor).toBe(0);
  });

  it("narrows the list as the query grows", () => {
    const typed = type(handleOpen(providerList()), "groq");
    expect(visibleKindRows(typed.search)).toHaveLength(1);
  });

  it("Backspace shortens the query and widens the list again", () => {
    const typed = type(handleOpen(providerList()), "groqx");
    expect(visibleKindRows(typed.search)).toHaveLength(0);
    const back = press(typed, { backspace: true });
    expect("wizard" in back && back.wizard.search).toBe("groq");
    expect(visibleKindRows("groq")).toHaveLength(1);
  });

  it("Backspace on an empty query closes the box", () => {
    const back = press(handleOpen(providerList()), { backspace: true });
    expect("wizard" in back && back.wizard.search).toBeNull();
  });

  it("arrows still walk the filtered list while the box is open", () => {
    const typed = type(handleOpen(providerList()), "cli");
    expect(visibleKindRows(typed.search)).toHaveLength(2);
    const down = press(typed, { downArrow: true });
    expect("wizard" in down && down.wizard.cursor).toBe(1);
    expect("wizard" in down && down.wizard.search).toBe("cli");
  });

  it("does not type control input or ctrl/meta combos into the query", () => {
    const opened = handleOpen(providerList());
    for (const [input, patch] of [
      ["[6~", {}],
      ["c", { ctrl: true }],
      ["c", { meta: true }],
    ] as const) {
      const result = handleProvidersWizardKey(input, { ...key(), ...patch }, opened);
      expect("wizard" in result && result.wizard.search).toBe("");
    }
  });
});

describe("Enter and Esc on a filtered list", () => {
  it("Enter picks the highlighted row of the filtered list, not of the whole one", () => {
    // "gemini" is row 4 of the unfiltered list; filtered it is row 0, and
    // the cursor sits at 0 — so a handler reading the unfiltered list
    // would pick the Claude Code CLI row instead.
    const typed = type(handleOpen(providerList()), "gemini");
    const picked = press(typed, { return: true });
    expect("wizard" in picked && picked.wizard.kind).toBe("gemini");
  });

  it("Enter selects the second row of a two-row result set", () => {
    const typed = type(handleOpen(providerList()), "cli");
    const moved = press(typed, { downArrow: true });
    if (!("wizard" in moved)) throw new Error("arrow was not handled");
    const picked = press(moved.wizard, { return: true });
    expect("wizard" in picked && picked.wizard.kind).toBe("codex-cli");
  });

  it("Enter on an empty result set does nothing at all", () => {
    const typed = type(handleOpen(providerList()), "zzzz");
    const picked = press(typed, { return: true });
    expect("wizard" in picked && picked.wizard.kind).toBeNull();
    expect("wizard" in picked && picked.wizard.phase).toBe("pick_kind");
  });

  it("the chosen row's phase change clears the query", () => {
    const typed = type(handleOpen(providerList()), "gemini");
    const picked = press(typed, { return: true });
    expect("wizard" in picked && picked.wizard.search).toBeNull();
  });

  it("a preset row clears the query on its way to the key screen", () => {
    const typed = type(handleOpen(providerList()), "groq");
    const picked = press(typed, { return: true });
    expect("wizard" in picked && picked.wizard.presetId).toBe("groq");
    expect("wizard" in picked && picked.wizard.search).toBeNull();
  });

  it("Esc clears the search and keeps the screen", () => {
    const typed = type(handleOpen(providerList()), "groq");
    const cleared = press(typed, { escape: true });
    expect("closed" in cleared).toBe(false);
    expect("wizard" in cleared && cleared.wizard.search).toBeNull();
    expect("wizard" in cleared && cleared.wizard.phase).toBe("pick_kind");
  });

  it("Esc again leaves the screen, as it did before the box existed", () => {
    const typed = type(handleOpen(providerList()), "groq");
    const cleared = press(typed, { escape: true });
    if (!("wizard" in cleared)) throw new Error("Esc was not handled");
    expect(press(cleared.wizard, { escape: true })).toEqual({
      handled: true,
      closed: true,
    });
  });
});

describe("the search box on the model screens", () => {
  function embeddingScreen(): ProvidersWizardState {
    return {
      ...createProvidersWizardState("add", { kind: "openrouter" }),
      phase: "pick_embedding",
    };
  }

  it("filters the embedding rows and Enter saves the highlighted one", () => {
    const typed = type(handleOpen(embeddingScreen()), "local");
    const picked = press(typed, { return: true });
    expect("submit" in picked && picked.submit).toBe(true);
    expect("wizard" in picked && picked.wizard.selectedEmbeddingChoiceId).toBe(
      "__local_embedding__",
    );
  });

  it("leaves the line screens alone — / is a character in a base URL", () => {
    const line = {
      ...createProvidersWizardState("add", { kind: "openai-compatible" }),
      phase: "base_url" as const,
    };
    const result = handleProvidersWizardKey("/", key(), line);
    expect("wizard" in result && result.wizard.baseUrlLine).toBe("/");
    expect("wizard" in result && result.wizard.search).toBeNull();
  });

  it("leaves the API key screen alone — / is a character in a key", () => {
    const apiKey = {
      ...createProvidersWizardState("add", { kind: "openrouter" }),
      phase: "api_key" as const,
    };
    const result = handleProvidersWizardKey("/", key(), apiKey);
    expect("wizard" in result && result.wizard.apiKeyBuffer).toBe("/");
    expect("wizard" in result && result.wizard.search).toBeNull();
  });
});

/** Open the search box, failing loudly if `/` was not accepted. */
function handleOpen(wizard: ProvidersWizardState): ProvidersWizardState {
  const opened = handleProvidersWizardKey("/", key(), wizard);
  if (!("wizard" in opened)) throw new Error("/ did not open the search box");
  return opened.wizard;
}
