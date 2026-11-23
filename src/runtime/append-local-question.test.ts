import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserConfigPath, writeUserConfigFileSync } from "../config/config-file.js";
import { resetConfigCache } from "../config/config-cache.js";
import { USER_CONFIG_DEFAULTS } from "../config/config-schema.js";
import {
  APPEND_LOCAL_ANSWER_FILE,
  APPEND_LOCAL_QUESTION,
  answerAppendLocalQuestion,
  inspectAppendLocalQuestion,
  rememberAppendLocalChosen,
  type AppendLocalQuestionPaths,
} from "./append-local-question.js";

/** ATO-1461: ask once about the old "local model as last resort" switch. */
describe("append-local question", () => {
  let stateDir: string;
  let paths: AppendLocalQuestionPaths;

  function writeFallback(fallback?: Record<string, unknown>): void {
    writeUserConfigFileSync(getUserConfigPath(stateDir), {
      ...USER_CONFIG_DEFAULTS,
      llm: {
        activeTextProvider: "openrouter",
        activeEmbeddingProvider: "local-llama",
        toolTransport: "auto",
        providers: [
          { id: "local-llama", kind: "llama-server" },
          { id: "openrouter", kind: "openrouter", defaultChatModel: "openai/gpt-4o-mini" },
        ],
        ...(fallback ? { fallback } : {}),
      },
    } as never);
    resetConfigCache();
  }

  function rawFallback(): Record<string, unknown> | undefined {
    const file = JSON.parse(readFileSync(getUserConfigPath(stateDir), "utf8")) as {
      llm: { fallback?: Record<string, unknown> };
    };
    return file.llm.fallback;
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "atomic-append-local-q-"));
    process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
    paths = { userConfigFile: getUserConfigPath(stateDir), stateDir };
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.ATOMIC_AGENT_STATE_DIR;
    resetConfigCache();
  });

  it("asks when appendLocal is true in config.json and nothing was answered", () => {
    writeFallback({ appendLocal: true });
    const status = inspectAppendLocalQuestion(paths);
    expect(status.question).toBe(APPEND_LOCAL_QUESTION);
    expect(status.question).toBe("Local model is set as your last-resort fallback. Keep it?");
    expect(status.detail).not.toBeNull();
    expect(status.appendLocal).toBe(true);
    expect(status.answer).toBeNull();
  });

  it("asks nothing when the switch is off, unset, or there is no config file", () => {
    expect(inspectAppendLocalQuestion(paths).question).toBeNull();
    writeFallback();
    expect(inspectAppendLocalQuestion(paths).question).toBeNull();
    writeFallback({ appendLocal: false });
    expect(inspectAppendLocalQuestion(paths).question).toBeNull();
  });

  it("Keep leaves config.json alone and is not asked again", () => {
    writeFallback({ chain: ["openrouter"], appendLocal: true, failureThreshold: 5 });
    const after = answerAppendLocalQuestion(paths, "keep");
    expect(after.question).toBeNull();
    expect(after.answer).toBe("keep");
    expect(rawFallback()).toEqual({ chain: ["openrouter"], appendLocal: true, failureThreshold: 5 });
    // A second start reads the same files: still nothing to ask.
    expect(inspectAppendLocalQuestion(paths).question).toBeNull();
  });

  it("Turn off writes appendLocal false, keeps the chain and knobs, and is not asked again", () => {
    writeFallback({ chain: ["openrouter"], appendLocal: true, failureThreshold: 5 });
    const after = answerAppendLocalQuestion(paths, "off");
    expect(after.question).toBeNull();
    expect(after.answer).toBe("off");
    expect(after.appendLocal).toBe(false);
    expect(rawFallback()).toEqual({ chain: ["openrouter"], appendLocal: false, failureThreshold: 5 });
    // Turned on again later by hand: the earlier answer stands, no new question.
    writeFallback({ appendLocal: true });
    expect(inspectAppendLocalQuestion(paths).question).toBeNull();
  });

  it("records nothing when the config write fails, so the question comes back", () => {
    writeFallback({ appendLocal: true });
    expect(() =>
      answerAppendLocalQuestion(paths, "off", {
        setAppendLocal: () => {
          throw new Error("disk full");
        },
      }),
    ).toThrow("disk full");
    expect(existsSync(join(stateDir, APPEND_LOCAL_ANSWER_FILE))).toBe(false);
    expect(inspectAppendLocalQuestion(paths).question).toBe(APPEND_LOCAL_QUESTION);
  });

  it("a corrupt answer file asks once more", () => {
    writeFallback({ appendLocal: true });
    writeFileSync(join(stateDir, APPEND_LOCAL_ANSWER_FILE), "{not json");
    expect(inspectAppendLocalQuestion(paths).question).toBe(APPEND_LOCAL_QUESTION);
  });

  it("turning the switch on in this version counts as Keep, without overwriting an earlier answer", () => {
    rememberAppendLocalChosen(stateDir);
    writeFallback({ appendLocal: true });
    expect(inspectAppendLocalQuestion(paths)).toMatchObject({ question: null, answer: "keep" });

    rmSync(join(stateDir, APPEND_LOCAL_ANSWER_FILE));
    answerAppendLocalQuestion(paths, "off");
    rememberAppendLocalChosen(stateDir);
    expect(inspectAppendLocalQuestion(paths).answer).toBe("off");
  });
});
