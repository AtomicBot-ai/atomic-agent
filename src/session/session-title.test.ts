import { describe, expect, it, vi } from "vitest";

import { createEmptySessionState } from "./session-state.js";
import type { SessionState } from "./session-state.js";
import {
  SESSION_TITLE_MAX_CHARS,
  SESSION_TITLE_METADATA_KEY,
  SESSION_TITLE_SESSION_PREFIX,
  extractSessionTitleText,
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

describe("generateSessionTitle on a cloud link", () => {
  it("asks with an emit function, because a bare prompt answers empty", async () => {
    // Observed on a real run: aimlapi/deepseek returned `content: ""`
    // and every session stayed unnamed. `native_tools` puts the answer
    // in `tool_calls`, which is why every other sub-call on this path
    // goes through `buildCloudSubcallRequest`.
    const complete = vi.fn(async () => ({
      content: "",
      toolCalls: [
        {
          function: {
            name: "emit_session_title",
            arguments: JSON.stringify({ title: "Подсчёт строк в notes.txt" }),
          },
        },
      ],
    }));
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: complete as never,
      slotId: () => 3,
      toolTransport: "native_tools",
    });
    expect(title).toBe("Подсчёт строк в notes.txt");
    const params = complete.mock.calls[0]?.[0] as unknown as {
      tools?: ReadonlyArray<{ function?: { name?: string } }>;
      toolChoice?: unknown;
      slotId: number;
    };
    expect(params.tools?.[0]?.function?.name).toBe("emit_session_title");
    expect(params.toolChoice).toBe("auto");
    // No slot affinity on a cloud link.
    expect(params.slotId).toBe(-1);
  });

  it("still reads a thinking model that answers in prose", async () => {
    // `tool_choice: "auto"`, so the model may ignore the tool.
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: async () => ({ content: "Fix the abort chord" }),
      slotId: () => 0,
      toolTransport: "native_tools",
    });
    expect(title).toBe("Fix the abort chord");
  });

  it("reports an empty answer instead of failing silently", async () => {
    const onError = vi.fn();
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: async () => ({ content: "" }),
      slotId: () => 0,
      toolTransport: "native_tools",
      onError,
    });
    expect(title).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("sends a plain prompt on a grammar link, where tools do not exist", async () => {
    const complete = vi.fn(async () => ({ content: "Fix the abort chord" }));
    await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete,
      slotId: () => 3,
    });
    const params = complete.mock.calls[0]?.[0] as unknown as {
      tools?: unknown;
      slotId: number;
    };
    expect(params.tools).toBeUndefined();
    expect(params.slotId).toBe(3);
  });
});

describe("extractSessionTitleText", () => {
  it("prefers the emitted argument and falls back to prose", () => {
    expect(
      extractSessionTitleText({
        content: "prose",
        toolCalls: [
          { function: { name: "x", arguments: '{"title":"emitted"}' } },
        ] as never,
      }),
    ).toBe("emitted");
    expect(
      extractSessionTitleText({
        content: "prose",
        toolCalls: [{ function: { name: "x", arguments: "not json" } }] as never,
      }),
    ).toBe("prose");
    expect(extractSessionTitleText({ content: "prose" })).toBe("prose");
  });
});
