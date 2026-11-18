import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { resetConfigCache } from "../config/config-cache.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { startTestHarness, type Harness } from "./test-harness.js";

interface Status {
  question: string | null;
  detail: string | null;
  appendLocal: boolean;
  answer: "keep" | "off" | null;
}

/** ATO-1461: the desktop's side of the one-time last-resort question. */
describe("/api/fallback/local-question", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { await harness.cleanup(); });

  function appendLocalOn(): void {
    writeUserConfigFileSync(getUserConfigPath(harness.stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server" },
          { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" },
        ],
        fallback: { appendLocal: true },
      },
    } as never);
    resetConfigCache();
  }
  const status = async () => (await (await fetch(`${harness.baseUrl}/api/fallback/local-question`)).json()) as Status;
  const answer = (body: Record<string, unknown>) => fetch(`${harness.baseUrl}/api/fallback/local-question`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("asks nothing on a fresh install", async () => {
    expect((await status()).question).toBeNull();
  });

  it("asks once when the switch is on, and Turn off writes it off", async () => {
    appendLocalOn();
    expect((await status()).question).toBe("Local model is set as your last-resort fallback. Keep it?");
    const response = await answer({ answer: "off" });
    expect(response.status).toBe(200);
    const after = (await response.json()) as Status;
    expect(after).toMatchObject({ question: null, appendLocal: false, answer: "off" });
    const file = JSON.parse(readFileSync(getUserConfigPath(harness.stateDir), "utf8")) as {
      llm: { fallback?: { appendLocal?: boolean } };
    };
    expect(file.llm.fallback?.appendLocal).toBe(false);
    expect((await status()).question).toBeNull();
  });

  it("Keep is remembered and validates input", async () => {
    appendLocalOn();
    expect((await answer({ answer: "maybe" })).status).toBe(400);
    expect((await answer({})).status).toBe(400);
    expect((await answer({ answer: "keep" })).status).toBe(200);
    expect(await status()).toMatchObject({ question: null, appendLocal: true, answer: "keep" });
  });
});
