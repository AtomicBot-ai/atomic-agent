import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "./session-state.js";
import type { SessionState } from "./session-state.js";
import {
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_SESSION_PREFIX,
  generateSessionTitle,
  readSessionTitle,
  sanitizeSessionTitle,
  shouldNameSession,
} from "./session-title.js";

function session(
  turns: SessionState["turns"],
  metadata: Record<string, unknown> = {},
): SessionState {
  const base = createEmptySessionState({ id: "s-1", workingDir: "/w" });
  return { ...base, turns, metadata };
}

const ASKED = {
  kind: "user",
  text: "почини отмену турна в TUI",
  at: 1,
} as const;
const ANSWERED = { kind: "assistant_reply", text: "готово", at: 2 } as const;

describe("sanitizeSessionTitle", () => {
  it("strips what a model reaches for and the prompt cannot forbid", () => {
    expect(sanitizeSessionTitle('"Fix the abort chord"')).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("Title: Fix the abort chord")).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("## Fix the abort chord")).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("Fix the abort chord.")).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("«Починить отмену»")).toBe("Починить отмену");
  });

  it("keeps an unpaired quote, which is part of the name", () => {
    expect(sanitizeSessionTitle(`Fix the "abort" chord`)).toBe(
      `Fix the "abort" chord`,
    );
  });

  it("collapses to one line and bounds the length", () => {
    expect(sanitizeSessionTitle("two\nlines")).toBe("two lines");
    const long = sanitizeSessionTitle("x".repeat(200));
    expect(long).toHaveLength(SESSION_TITLE_MAX_CHARS);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("answers null when nothing survives", () => {
    expect(sanitizeSessionTitle("   ")).toBeNull();
    expect(sanitizeSessionTitle('""')).toBeNull();
  });
});

describe("shouldNameSession", () => {
  it("waits for the first answered turn", () => {
    expect(shouldNameSession(session([ASKED]))).toBe(false);
    expect(shouldNameSession(session([ASKED, ANSWERED]))).toBe(true);
  });

  it("never renames a session that already has a name", () => {
    // A label the operator has navigated by must not move under them.
    const named = session([ASKED, ANSWERED], {
      [SESSION_TITLE_METADATA_KEY]: "Починить отмену",
    });
    expect(shouldNameSession(named)).toBe(false);
  });

  it("has nothing to name a session nobody spoke to", () => {
    expect(shouldNameSession(session([]))).toBe(false);
  });
});

describe("generateSessionTitle", () => {
  it("asks under its own session partition, not the turn's", async () => {
    // The fallback chain keys breaker state by session id; on the bare
    // id a refusal here would flip the turn's own sticky override.
    const complete = vi.fn(async () => ({ content: "Fix the abort chord" }));
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete,
      slotId: () => 3,
    });
    expect(title).toBe("Fix the abort chord");
    const params = complete.mock.calls[0]?.[0] as unknown as {
      sessionId: string;
      slotId: number;
      prompt: string;
    };
    expect(params.sessionId).toBe(`${SESSION_TITLE_SESSION_PREFIX}s-1`);
    expect(params.slotId).toBe(3);
    expect(params.prompt).toContain("почини отмену турна в TUI");
  });

  it("answers null and reports rather than throwing", async () => {
    // Naming is a nicety and the turn is already saved: it must never
    // fail a reply.
    const onError = vi.fn();
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: async () => {
        throw new Error("402 no credit");
      },
      slotId: () => 0,
      onError,
    });
    expect(title).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("answers null when the model says nothing usable", async () => {
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: async () => ({ content: "   " }),
      slotId: () => 0,
    });
    expect(title).toBeNull();
  });
});

describe("readSessionTitle", () => {
  it("reads a stored name and ignores everything else", () => {
    expect(readSessionTitle({ title: "Fix the chord" })).toBe("Fix the chord");
    expect(readSessionTitle({ title: "   " })).toBeNull();
    expect(readSessionTitle({ title: 42 })).toBeNull();
    expect(readSessionTitle({})).toBeNull();
    expect(readSessionTitle(undefined)).toBeNull();
  });
});
