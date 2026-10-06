import { describe, expect, it, vi } from "vitest";

import { stoppedTurnMarker } from "./conversation-turn.js";
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
  stripTitleReasoning,
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

describe("sanitizeSessionTitle on a thinking model", () => {
  it("drops a closed think block and keeps the answer", () => {
    // Stored live from a local Qwen 3.5 4B.
    expect(
      sanitizeSessionTitle(
        "<think>\n\n</think>\n\nLighthouse Keeper's Secret Diary",
      ),
    ).toBe("Lighthouse Keeper's Secret Diary");
    expect(
      sanitizeSessionTitle(
        "<think>The user wants a title.</think> Починить отмену",
      ),
    ).toBe("Починить отмену");
  });

  it("cuts up to a close whose open the template prefilled", () => {
    expect(
      sanitizeSessionTitle(
        "Okay, the user asks about tabs.\n</think>\nFix tabs",
      ),
    ).toBe("Fix tabs");
  });

  it("answers null for reasoning that never closed", () => {
    // The other title stored live: cut off by the token bound mid-thought.
    expect(
      sanitizeSessionTitle(
        "<think> Thinking Process: 1. **Analyze the Request**: the user",
      ),
    ).toBeNull();
  });

  it("answers null for untagged reasoning prose", () => {
    expect(
      sanitizeSessionTitle("Thinking Process:\n1. Analyze the request"),
    ).toBeNull();
    expect(
      sanitizeSessionTitle("**Thinking Process:** 1. Analyze the request"),
    ).toBeNull();
  });

  it("drops Gemma's thought channel and stray control tokens", () => {
    expect(
      sanitizeSessionTitle(
        "<|channel>thought\nhmm<channel|>Fix the chord<|im_end|>",
      ),
    ).toBe("Fix the chord");
  });

  it("strips markdown emphasis around the title", () => {
    expect(sanitizeSessionTitle("**Fix the abort chord**")).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("**Title:** Fix the abort chord")).toBe(
      "Fix the abort chord",
    );
    expect(sanitizeSessionTitle("`Fix the abort chord`")).toBe(
      "Fix the abort chord",
    );
  });

  it("leaves a title that merely mentions thinking alone", () => {
    expect(stripTitleReasoning("Thinking process for hiring")).toBe(
      "Thinking process for hiring",
    );
    expect(sanitizeSessionTitle("Fix the abort chord")).toBe(
      "Fix the abort chord",
    );
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

  it("does not count a stopped turn as answered", () => {
    // Its stop marker is a reply row, but nothing in it answers.
    const stopped = session([ASKED, stoppedTurnMarker(2)]);
    expect(shouldNameSession(stopped)).toBe(false);
    const answeredLater = session([
      ...stopped.turns,
      { ...ASKED, at: 3 },
      { ...ANSWERED, at: 4 },
    ]);
    expect(shouldNameSession(answeredLater)).toBe(true);
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

  it("asks a llama-server link with thinking off", async () => {
    const complete = vi.fn(async () => ({ content: "Fix the abort chord" }));
    await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete,
      slotId: () => 3,
    });
    const params = complete.mock.calls[0]?.[0] as unknown as {
      prompt: string;
      chat?: { system: string; user: string; enableThinking?: boolean };
    };
    expect(params.chat?.enableThinking).toBe(false);
    // The raw text stays beside it for a server that cannot render.
    expect(params.chat?.user).toBe(params.prompt);
  });

  it("sends the raw prompt alone when the operator turned templates off", async () => {
    const complete = vi.fn(async () => ({ content: "Fix the abort chord" }));
    await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete,
      slotId: () => 3,
      serverTemplate: false,
    });
    const params = complete.mock.calls[0]?.[0] as unknown as {
      chat?: unknown;
    };
    expect(params.chat).toBeUndefined();
  });

  it("falls back to no title when the answer is all reasoning", async () => {
    const onError = vi.fn();
    const title = await generateSessionTitle(session([ASKED, ANSWERED]), {
      complete: async () => ({
        content: "<think> Thinking Process: 1. **Analyze the Request**",
      }),
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

  it("cleans a title stored with the model's reasoning in it", () => {
    // Stored before the namer stripped reasoning; existing chats must
    // read right without a migration.
    expect(
      readSessionTitle({
        title: "<think> </think> Lighthouse Keeper's Secret Dia…",
      }),
    ).toBe("Lighthouse Keeper's Secret Dia…");
    expect(
      readSessionTitle({
        title: "<think> Thinking Process: 1. **Analyze the Requ…",
      }),
    ).toBeNull();
  });

  it("returns a clean stored title untouched", () => {
    // Not re-sanitized: a name the operator has seen must not change.
    expect(readSessionTitle({ title: "Fix the chord." })).toBe(
      "Fix the chord.",
    );
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
