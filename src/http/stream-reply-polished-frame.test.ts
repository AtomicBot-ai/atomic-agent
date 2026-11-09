import { describe, expect, it } from "vitest";

import { buildStreamEventHook } from "./openai-chat-completions.js";

/**
 * ATO-967: the final reply is polished after its deltas have already
 * streamed. The client must not get the body twice; an extensions host
 * gets the polished text as `event: reply_polished` to swap in.
 */
describe("polished replies over SSE", () => {
  const run = (events: unknown[], extensionsEnabled: boolean) => {
    const content: string[] = [];
    const frames: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const writer = {
      closed: false,
      writeEvent(name: string | null, payload: unknown) {
        if (name !== null) {
          frames.push({ name, payload: payload as Record<string, unknown> });
          return;
        }
        const c = (payload as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content;
        if (typeof c === "string") content.push(c);
      },
    };
    const env = {
      completionId: "cmpl-1",
      created: 0,
      session: { id: "sess-1" },
      request: { model: "atomic-agent", extensionsEnabled },
    } as never;
    const hook = buildStreamEventHook(writer as never, env);
    for (const e of events) hook(e as never);
    return { content: content.join(""), frames };
  };
  const step = (stepIndex: number) => ({ type: "step_started", stepIndex });
  const delta = (text: string) => ({ type: "llm_event", event: { type: "assistant_delta", text } });
  const reply = (text: string, rawText?: string) => ({
    type: "llm_event",
    event: { type: "assistant_reply", text, ...(rawText !== undefined ? { rawText } : {}) },
  });

  const raw = "Sure! The build passes.\n\n\n\nThe build passes.";
  const polished = "The build passes.";

  it("does not stream the body again and sends the polished text to an extensions host", () => {
    const out = run([step(0), delta(raw), reply(polished, raw)], true);
    expect(out.content).toBe(raw);
    const polishedFrames = out.frames.filter((f) => f.name === "reply_polished");
    expect(polishedFrames).toHaveLength(1);
    expect(polishedFrames[0]!.payload.text).toBe(polished);
    expect(polishedFrames[0]!.payload.object).toBe("chat.completion.reply_polished");
    expect(polishedFrames[0]!.payload.session_id).toBe("sess-1");
  });

  it("keeps a plain OpenAI stream free of the frame", () => {
    const out = run([step(0), delta(raw), reply(polished, raw)], false);
    expect(out.content).toBe(raw);
    expect(out.frames.filter((f) => f.name === "reply_polished")).toHaveLength(0);
  });

  it("sends the rest of a half-streamed reply from the raw text, then the frame", () => {
    const out = run([step(0), delta("Sure! The build"), reply(polished, raw)], true);
    expect(out.content).toBe(raw);
    expect(out.frames.some((f) => f.name === "reply_polished")).toBe(true);
  });

  it("sends the polished text as content when nothing streamed", () => {
    const out = run([step(0), reply(polished, raw)], true);
    expect(out.content).toBe(polished);
    expect(out.frames.filter((f) => f.name === "reply_polished")).toHaveLength(0);
  });

  it("sends no frame for a reply the polish left alone", () => {
    const out = run([step(0), delta("Done."), reply("Done.")], true);
    expect(out.content).toBe("Done.");
    expect(out.frames.filter((f) => f.name === "reply_polished")).toHaveLength(0);
  });
});
