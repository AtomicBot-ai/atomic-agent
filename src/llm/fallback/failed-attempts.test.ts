import { describe, expect, it } from "vitest";

import { OpenAiHttpError } from "../provider/openai/openai-http.js";
import { TransportError } from "../reliability/llm-failures.js";
import {
  attachFailedAttempts,
  describeFailedAttempts,
  readFailedAttempts,
  summarizeFailedAttempts,
} from "./failed-attempts.js";

function cloud404(): OpenAiHttpError {
  return new OpenAiHttpError(
    "openai provider 404: No endpoints found for z-ai/glm-5.3-flash.",
    404,
    "https://openrouter.ai/api/v1/chat/completions",
    false,
    null,
    "openrouter",
  );
}

describe("the links a fallback chain tried before the error it threw", () => {
  it("are recorded beside the error without touching it", () => {
    const err = new TypeError("fetch failed");
    const names = Object.getOwnPropertyNames(err);
    const symbols = Object.getOwnPropertySymbols(err);
    const json = JSON.stringify(err);

    attachFailedAttempts(err, [{ providerId: "openrouter", error: cloud404() }]);

    expect(err.message).toBe("fetch failed");
    expect(Object.getOwnPropertyNames(err)).toEqual(names);
    expect(Object.getOwnPropertySymbols(err)).toEqual(symbols);
    expect(JSON.stringify(err)).toBe(json);
    expect(readFailedAttempts(err).map((a) => a.providerId)).toEqual([
      "openrouter",
    ]);
  });

  it("are found through the step executor's TransportError wrap", () => {
    const raw = new TypeError("fetch failed");
    attachFailedAttempts(raw, [{ providerId: "openrouter", error: cloud404() }]);
    const wrapped = new TransportError(raw.message, null, "", { cause: raw });

    expect(describeFailedAttempts(wrapped)).toBe(
      ' (after "openrouter" failed: openai provider 404: No endpoints found for z-ai/glm-5.3-flash.)',
    );
  });

  it("render as nothing when no link failed first", () => {
    const err = new TypeError("fetch failed");
    attachFailedAttempts(err, []);
    expect(readFailedAttempts(err)).toEqual([]);
    expect(describeFailedAttempts(err)).toBe("");
    expect(summarizeFailedAttempts(err)).toEqual([]);
  });

  it("ignore a thrown primitive, which has nowhere to hang them", () => {
    attachFailedAttempts("fetch failed", [
      { providerId: "openrouter", error: cloud404() },
    ]);
    expect(describeFailedAttempts("fetch failed")).toBe("");
  });

  it("name every link in order, each reason on one capped line", () => {
    const err = new Error("fetch failed");
    attachFailedAttempts(err, [
      { providerId: "openrouter", error: cloud404() },
      {
        providerId: "groq",
        error: new Error(`server trouble\n${"x".repeat(400)}`),
      },
    ]);

    const note = describeFailedAttempts(err);
    expect(note.startsWith(' (after "openrouter" failed: openai provider 404')).toBe(
      true,
    );
    expect(note).toContain('; "groq" failed: server trouble x');
    expect(note).not.toContain("\n");
    expect(note.length).toBeLessThan(420);
    expect(summarizeFailedAttempts(err)).toEqual([
      {
        providerId: "openrouter",
        reason: "openai provider 404: No endpoints found for z-ai/glm-5.3-flash.",
      },
      { providerId: "groq", reason: expect.stringMatching(/…$/) },
    ]);
  });

  it("stop at a cause chain that loops back on itself", () => {
    const err = new Error("fetch failed");
    (err as { cause?: unknown }).cause = err;
    expect(readFailedAttempts(err)).toEqual([]);
  });
});
