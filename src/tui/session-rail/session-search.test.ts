import { describe, expect, it, vi } from "vitest";

import { reduceTuiState } from "../agent-event-reducer.js";
import { createInitialTuiState, type SessionPickerEntry } from "../tui-state.js";
import {
  createSessionPickerSearch,
  normaliseQuery,
  pickerQuery,
  SEARCH_TEXT_MAX_CHARS,
  snippetAround,
  visiblePickerSessions,
} from "./session-search.js";

/**
 * ATO-1153: history search in the session picker. Typing narrows the
 * list to sessions whose title or message text holds the query; a match
 * in the text shows the words around it.
 */

function entry(id: string, preview: string, updatedAt = 1): SessionPickerEntry {
  return {
    sessionId: id,
    workingDir: "/tmp/w",
    turnCount: 1,
    stepCount: 1,
    updatedAt,
    preview,
    pinned: false,
  };
}

const lines: Record<string, { text: string }[]> = {
  "s-1": [{ text: "plan the trip" }, { text: "Book the train to Lisbon on Friday." }],
  "s-2": [{ text: "fix the login bug" }, { text: "The cookie was not set." }],
  "s-3": [],
};

const ids = (rows: readonly SessionPickerEntry[]) => rows.map((r) => r.sessionId);

describe("createSessionPickerSearch", () => {
  const list = [entry("s-1", "Trip plan"), entry("s-2", "Login bug"), entry("s-3", "Empty")];

  it("returns the list itself for an empty or blank query", () => {
    const search = createSessionPickerSearch((id) => lines[id] ?? []);
    expect(search(list, "")).toBe(list);
    expect(search(list, "   ")).toBe(list);
  });

  it("matches titles case-insensitively and keeps the title as the preview", () => {
    const search = createSessionPickerSearch((id) => lines[id] ?? []);
    const rows = search(list, "LOGIN");
    expect(ids(rows)).toEqual(["s-2"]);
    expect(rows[0]?.preview).toBe("Login bug");
  });

  it("matches message text and shows the matched words instead of the title", () => {
    const search = createSessionPickerSearch((id) => lines[id] ?? []);
    const rows = search(list, "lisbon");
    expect(ids(rows)).toEqual(["s-1"]);
    expect(rows[0]?.preview).toContain("Lisbon");
    expect(rows[0]?.preview.length).toBeLessThanOrEqual(48);
  });

  it("matches titles only without a text source", () => {
    const search = createSessionPickerSearch();
    expect(ids(search(list, "cookie"))).toEqual([]);
    expect(ids(search(list, "trip"))).toEqual(["s-1"]);
  });

  it("reads each session's text once until it changes", () => {
    const source = vi.fn((id: string) => lines[id] ?? []);
    const search = createSessionPickerSearch(source);
    search(list, "cookie");
    search(list, "cooki");
    search(list, "cookie set");
    // "Trip plan", "Login bug" and "Empty" never match by title here,
    // so each text is read on the first query and reused after.
    expect(source).toHaveBeenCalledTimes(3);
    const touched = [entry("s-1", "Trip plan", 2), list[1]!, list[2]!];
    search(touched, "cookie");
    expect(source).toHaveBeenCalledTimes(4);
    expect(source).toHaveBeenLastCalledWith("s-1");
  });

  it("does not read text for a session its title already matched", () => {
    const source = vi.fn((id: string) => lines[id] ?? []);
    const search = createSessionPickerSearch(source);
    search([entry("s-2", "Login bug")], "login");
    expect(source).not.toHaveBeenCalled();
  });

  it("searches only the first part of a very long transcript", () => {
    const long = [{ text: "a".repeat(SEARCH_TEXT_MAX_CHARS) }, { text: "needle" }];
    const search = createSessionPickerSearch(() => long);
    expect(search([entry("s-9", "Long")], "needle")).toEqual([]);
  });

  it("treats a store that throws as no text", () => {
    const search = createSessionPickerSearch(() => {
      throw new Error("The database connection is not open");
    });
    expect(ids(search(list, "trip"))).toEqual(["s-1"]);
    expect(ids(search(list, "cookie"))).toEqual([]);
  });
});

describe("snippetAround", () => {
  it("cuts around the match with ellipses on the cut sides", () => {
    const text = `${"x".repeat(100)} the needle is here ${"y".repeat(100)}`;
    const at = text.indexOf("needle");
    const snippet = snippetAround(text, at, 6, 46);
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("keeps a short text whole and on one line", () => {
    expect(snippetAround("one\ntwo  three", 4, 3, 46)).toBe("one two three");
  });
});

describe("normaliseQuery", () => {
  it("trims, collapses whitespace and lowercases", () => {
    expect(normaliseQuery("  Login\n BUG ")).toBe("login bug");
  });
});

describe("pickerQuery and the draft the picker opened over", () => {
  it("is what was typed after the draft", () => {
    expect(pickerQuery({ inputValue: "my draftlogin", sessionPickerDraft: "my draft" })).toBe("login");
    expect(pickerQuery({ inputValue: "my draft", sessionPickerDraft: "my draft" })).toBe("");
  });

  it("is the whole text once the draft itself was edited", () => {
    expect(pickerQuery({ inputValue: "my dr", sessionPickerDraft: "my draft" })).toBe("my dr");
  });

  it("narrows the open picker only", () => {
    const base = createInitialTuiState({
      sessionId: "s-0",
      workingDir: "/tmp",
      llamaUrl: "http://127.0.0.1:8080",
      browserChannel: "chrome",
      browserHeadless: false,
      approvalLevel: 5,
      maxSteps: 10,
      completionMaxTokens: 2048,
      skillCount: 0,
    });
    const list = [entry("s-1", "Trip plan"), entry("s-2", "Login bug")];
    const opened = reduceTuiState(
      { ...base, inputValue: "draft " },
      { type: "session_picker_opened", sessions: list },
    );
    expect(opened.sessionPickerDraft).toBe("draft ");
    const typed = reduceTuiState(opened, { type: "input_changed", value: "draft login" });
    expect(ids(visiblePickerSessions(typed, undefined))).toEqual(["s-2"]);
    // Esc / a click outside: the search goes, the draft stays.
    const closed = reduceTuiState(typed, { type: "session_picker_closed" });
    expect(closed.sessionPickerOpen).toBe(false);
    expect(closed.inputValue).toBe("draft ");
    expect(visiblePickerSessions(closed, undefined)).toBe(closed.sessionPickerList);
  });
});
