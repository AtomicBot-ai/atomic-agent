import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readUserConfigFileSync } from "../config/config-file.js";
import { setFallbackAppendLocalInConfig } from "../config/llm-provider-commands.js";

/**
 * The one-time question for people who still have the old "local model as
 * the last-resort fallback" switch on (ATO-1461).
 *
 * Since v0.7.0 the local model is not added to the fallback chain unless
 * the person turns `llm.fallback.appendLocal` on (`DEFAULT_APPEND_LOCAL`).
 * Whoever turned it on before still has it in `config.json`, so a cloud
 * failure can still move their turn to the local model. Nadya's decision
 * (17.11): after the update ask once, "Local model is set as your
 * last-resort fallback. Keep it?" with Keep / Turn off, and remember the
 * answer. Nothing is changed without an answer.
 *
 * Shared by the TUI (startup modal) and the HTTP routes the desktop reads
 * (`GET` / `POST /api/fallback/local-question`). Both run on the same
 * `~/.atomic-agent`, so an answer in one is never asked again in the other.
 * The answer lives in the state dir, not in `config.json`: it is a record
 * of a question shown, not a setting.
 */

export const APPEND_LOCAL_QUESTION = "Local model is set as your last-resort fallback. Keep it?";

/** One plain line under the question: what each answer does. */
export const APPEND_LOCAL_QUESTION_DETAIL =
  "When your cloud model fails, the agent switches the chat to your local model. " +
  "Keep leaves it on; Turn off stops the switch. You can change it later in the Fallback settings.";

export type AppendLocalAnswer = "keep" | "off";

export interface AppendLocalQuestionPaths {
  /** `config.json` the flag is read from and "Turn off" writes to. */
  userConfigFile: string;
  /** Where the answer is remembered. */
  stateDir: string;
}

export interface AppendLocalQuestionStatus {
  /** The question to show, or null when there is nothing to ask. */
  question: string | null;
  /** What each answer does; null with `question`. */
  detail: string | null;
  /** `llm.fallback.appendLocal` as written in `config.json` (false when unset). */
  appendLocal: boolean;
  /** The answer remembered earlier, or null. */
  answer: AppendLocalAnswer | null;
}

/** The remembered answer; lives in the state dir. */
export const APPEND_LOCAL_ANSWER_FILE = "append-local-question.json";

export function inspectAppendLocalQuestion(paths: AppendLocalQuestionPaths): AppendLocalQuestionStatus {
  const appendLocal = appendLocalOnDisk(paths.userConfigFile);
  const answer = readAnswer(paths.stateDir);
  const due = appendLocal && answer === null;
  return {
    question: due ? APPEND_LOCAL_QUESTION : null,
    detail: due ? APPEND_LOCAL_QUESTION_DETAIL : null,
    appendLocal,
    answer,
  };
}

/**
 * Record the person's answer. "off" writes `llm.fallback.appendLocal:
 * false` first (the chain and timing knobs stay); "keep" changes nothing
 * in `config.json`. Either way the question is not asked again. Throws
 * when the config write fails, and then nothing is recorded, so the
 * question comes back on the next start.
 */
export function answerAppendLocalQuestion(
  paths: AppendLocalQuestionPaths,
  answer: AppendLocalAnswer,
  deps: { setAppendLocal?: (value: boolean, path: string) => void } = {},
): AppendLocalQuestionStatus {
  if (answer === "off") {
    (deps.setAppendLocal ?? setFallbackAppendLocalInConfig)(false, paths.userConfigFile);
  }
  if (!writeAnswer(paths.stateDir, answer)) {
    throw new Error(`could not save the answer in ${join(paths.stateDir, APPEND_LOCAL_ANSWER_FILE)}`);
  }
  return inspectAppendLocalQuestion(paths);
}

/**
 * The person turned the switch on themselves in this version (the
 * Fallback pane, the desktop toggle): that is the answer, so the question
 * never asks about a choice they just made. Best effort.
 */
export function rememberAppendLocalChosen(stateDir: string): void {
  if (readAnswer(stateDir) === null) writeAnswer(stateDir, "keep");
}

function appendLocalOnDisk(userConfigFile: string): boolean {
  try {
    return readUserConfigFileSync(userConfigFile)?.llm?.fallback?.appendLocal === true;
  } catch {
    // An unreadable or invalid file is reported by the config loader;
    // asking about it here would only add a second voice.
    return false;
  }
}

function readAnswer(stateDir: string): AppendLocalAnswer | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(stateDir, APPEND_LOCAL_ANSWER_FILE), "utf8"));
    const answer = (parsed as { answer?: unknown } | null)?.answer;
    return answer === "keep" || answer === "off" ? answer : null;
  } catch {
    // Missing until the first answer; a corrupt file asks once more.
    return null;
  }
}

function writeAnswer(stateDir: string, answer: AppendLocalAnswer): boolean {
  const path = join(stateDir, APPEND_LOCAL_ANSWER_FILE);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(tmp, `${JSON.stringify({ answer, answeredAt: new Date().toISOString() })}\n`);
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing was written, or nothing can be removed.
    }
    return false;
  }
}
