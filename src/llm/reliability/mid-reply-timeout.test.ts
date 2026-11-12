import { describe, expect, it } from "vitest";
import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { TransportError } from "./llm-failures.js";
import { readMidReplyTimeout } from "./mid-reply-timeout.js";

const URL = "https://vendor/v1/chat/completions";
const inStream = (status: number | null, streamError: string) =>
  new OpenAiHttpError(`openai provider ${status}: ${streamError}`, status, URL, false, null, "openrouter", undefined, { streamError });

describe("readMidReplyTimeout", () => {
  it.each([504, 408, 524])("reads a %i reported inside the stream", (status) => {
    expect(readMidReplyTimeout(inStream(status, "A Timeout Occurred"))).toEqual({ provider: "openrouter", status, url: URL });
  });

  it("reads a timeout message that carries no status", () => {
    expect(readMidReplyTimeout(inStream(null, "Upstream idle timeout"))?.status).toBeNull();
  });

  it("reads a time-limit status whose message does not say timeout", () => {
    expect(readMidReplyTimeout(inStream(504, "Upstream error"))?.status).toBe(504);
  });

  it("reads timeout words on any other status", () => {
    expect(readMidReplyTimeout(inStream(502, "A Timeout Occurred"))?.status).toBe(502);
  });

  it("finds it under the step executor's TransportError", () => {
    const wrapped = new TransportError("wrapped", 504, URL, { cause: inStream(504, "A Timeout Occurred") });
    expect(readMidReplyTimeout(wrapped)?.provider).toBe("openrouter");
  });

  it.each([
    ["a dropped connection", inStream(502, "Network connection lost")],
    ["a reply ended with an error", inStream(504, "the provider ended the completion with an error")],
    ["a 504 before any reply", new OpenAiHttpError("openai provider 504", 504, URL, false, null, "openrouter")],
    ["an unrelated failure", new Error("A Timeout Occurred")],
    ["a non-error", undefined],
  ])("ignores %s", (_name, err) => {
    expect(readMidReplyTimeout(err)).toBeNull();
  });
});
