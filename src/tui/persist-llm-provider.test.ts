import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetConfigCache } from "../config/config-cache.js";
import {
  getUserConfigPath,
  writeUserConfigFileSync,
} from "../config/config-file.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import { getConfig } from "../config/index.js";
import {
  dotenvKeyForProviderKind,
  parseAddProviderJson,
  restoreProviderDefaultChatModelInConfig,
  setProviderDefaultChatModelInConfig,
} from "./persist-llm-provider.js";

describe("persist-llm-provider", () => {
  it("maps every wizard kind to its dotenv key", () => {
    expect(dotenvKeyForProviderKind("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(dotenvKeyForProviderKind("aimlapi")).toBe("AIMLAPI_API_KEY");
    expect(dotenvKeyForProviderKind("gemini")).toBe("GEMINI_API_KEY");
    expect(dotenvKeyForProviderKind("openai-compatible")).toBe(
      "OPENAI_COMPAT_API_KEY",
    );
  });

  it("parses a bare aimlapi provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "aimlapi",
        kind: "aimlapi",
        defaultChatModel: "openai/gpt-5-2",
      }),
    );
    expect(entry.id).toBe("aimlapi");
    expect(entry.kind).toBe("aimlapi");
  });

  it("parses a bare openrouter provider entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        id: "openrouter",
        kind: "openrouter",
        defaultChatModel: "openai/gpt-4o-mini",
      }),
    );
    expect(entry.id).toBe("openrouter");
    expect(entry.kind).toBe("openrouter");
  });

  it("parses llm.providers envelope with one entry", () => {
    const entry = parseAddProviderJson(
      JSON.stringify({
        llm: {
          providers: [
            {
              id: "cloud",
              kind: "openai-compatible",
              baseUrl: "https://api.example.com/v1",
              defaultChatModel: "gpt-4o",
            },
          ],
        },
      }),
    );
    expect(entry.id).toBe("cloud");
  });
});

/**
 * `restoreProviderDefaultChatModelInConfig` is the undo half of
 * `setProviderDefaultChatModelInConfig`, and the only writer that can
 * express *unset* — which is why it exists and why it is tested here
 * against a real config file rather than only through the callers that
 * happen to use it.
 */
describe("restoreProviderDefaultChatModelInConfig", () => {
  let stateDir: string;

  function write(defaultChatModel?: string): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "cloud",
        activeEmbeddingProvider: "cloud",
        toolTransport: "auto",
        providers: [
          {
            id: "cloud",
            kind: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            ...(defaultChatModel === undefined ? {} : { defaultChatModel }),
          },
          { id: "other", kind: "openrouter", defaultChatModel: "keep/me" },
        ],
      },
    });
    resetConfigCache();
  }

  /** The raw file, to tell "key absent" from "key present as undefined". */
  function rawProvider(id: string): Record<string, unknown> {
    const file = JSON.parse(
      readFileSync(getUserConfigPath(stateDir), "utf8"),
    ) as { llm: { providers: Array<Record<string, unknown>> } };
    const entry = file.llm.providers.find((p) => p.id === id);
    if (!entry) throw new Error(`no provider ${id} in the written file`);
    return entry;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-persist-llm-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("puts a previous model id back", () => {
    write("was-here");
    setProviderDefaultChatModelInConfig("cloud", "rejected-later");
    restoreProviderDefaultChatModelInConfig("cloud", "was-here");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "cloud")
        ?.defaultChatModel,
    ).toBe("was-here");
  });

  it("removes the key when there was no previous pin", () => {
    // The state `setProviderDefaultChatModelInConfig` cannot reach: it
    // refuses an empty id, so without this function a rollback could
    // only ever overwrite, never clear.
    write();
    expect(() => setProviderDefaultChatModelInConfig("cloud", " ")).toThrow(
      /empty/,
    );
    setProviderDefaultChatModelInConfig("cloud", "rejected-later");
    expect(rawProvider("cloud").defaultChatModel).toBe("rejected-later");

    restoreProviderDefaultChatModelInConfig("cloud", undefined);
    // Deleted outright, not written as `null` or `""` — the config
    // parser and every reader treat those differently from absent.
    expect(rawProvider("cloud")).not.toHaveProperty("defaultChatModel");
    expect(
      getConfig().llm?.providers.find((p) => p.id === "cloud")
        ?.defaultChatModel,
    ).toBeUndefined();
  });

  it("leaves every other provider alone", () => {
    write("was-here");
    restoreProviderDefaultChatModelInConfig("cloud", undefined);
    expect(rawProvider("other").defaultChatModel).toBe("keep/me");
  });

  it("is a no-op for a provider id that is not configured", () => {
    // A rollback path must not throw a second error over the first one
    // it is trying to report.
    write("was-here");
    expect(() =>
      restoreProviderDefaultChatModelInConfig("ghost", "anything"),
    ).not.toThrow();
    expect(rawProvider("cloud").defaultChatModel).toBe("was-here");
  });
});
