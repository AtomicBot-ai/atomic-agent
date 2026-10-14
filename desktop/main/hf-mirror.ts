/**
 * Settings › Models › Hugging Face mirror, main-process half.
 *
 * Where Hugging Face is reached from, decided the way the agent decides
 * it so the window's lookup and `atag models pull` never disagree:
 *
 *   1. `HF_ENDPOINT` in this process's environment,
 *   2. `HF_ENDPOINT` in `<stateDir>/.env`, which load-dotenv.ts applies to
 *      the CLI's environment on every run (this window never reads it into
 *      its own, so it is looked up here),
 *   3. `localModels.download.hfEndpoint` in `<stateDir>/config.json`,
 *   4. https://huggingface.co.
 *
 * huggingface.ts reads (1) itself (`resolveHuggingFaceEndpoint`); (2) or
 * (3) is pushed into it as the configured value before each lookup and
 * each projector download, the way load-config.ts pushes (3) in the agent.
 *
 * The field writes (3) only, through the same whole-file `config set` as
 * every other Settings write, and only a value the agent's own parser
 * accepts (local-models-parser.ts parseHfEndpoint: an http(s) origin).
 * An empty field writes the default rather than deleting the key, because
 * that parser refuses an empty string.
 */

import {
  DEFAULT_HF_ENDPOINT,
  huggingFaceEndpointFromConfig,
  normalizeHuggingFaceEndpoint,
  setDefaultHuggingFaceEndpoint,
} from "./huggingface.js";

export const HF_ENDPOINT_KEY = "localModels.download.hfEndpoint";

/** What the field shows. Hosts and origins only; nothing secret lives here. */
export interface HfMirrorState {
  /** The saved mirror, or null when config.json names the default (or nothing). */
  configured: string | null;
  /** An `HF_ENDPOINT` that overrides the field, and where it was found. */
  override: { endpoint: string; from: "environment" | ".env" } | null;
  /** What a lookup or a download uses right now. */
  endpoint: string;
  /** `endpoint`'s host, for "asking hf-mirror.com…". */
  host: string;
}

export interface HfMirrorSources {
  /** The parsed config.json, or null when it is missing or unreadable. */
  config: unknown;
  /** `process.env.HF_ENDPOINT`. */
  env: string | undefined;
  /** `HF_ENDPOINT` from `<stateDir>/.env`, if it names one. */
  dotenv: string | undefined;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "huggingface.co";
  }
}

/**
 * The `.env` value, as load-dotenv.ts would apply it: never when the
 * process already has a non-empty `HF_ENDPOINT`, even an unusable one
 * (the CLI then falls back to config.json, and so does this).
 */
function dotenvEndpoint(src: HfMirrorSources): string | null {
  if (src.env) return null;
  return src.dotenv ? normalizeHuggingFaceEndpoint(src.dotenv) : null;
}

/** The four sources above, reduced to what the field and the lookup use. Pure. */
export function hfMirrorState(src: HfMirrorSources): HfMirrorState {
  const saved = huggingFaceEndpointFromConfig(src.config);
  const configured = saved === DEFAULT_HF_ENDPOINT ? null : saved;
  const fromEnv = src.env ? normalizeHuggingFaceEndpoint(src.env) : null;
  const fromDotenv = dotenvEndpoint(src);
  const override = fromEnv
    ? { endpoint: fromEnv, from: "environment" as const }
    : fromDotenv
      ? { endpoint: fromDotenv, from: ".env" as const }
      : null;
  const endpoint = override?.endpoint ?? saved;
  return { configured, override, endpoint, host: hostOf(endpoint) };
}

/**
 * Push the configured value into huggingface.ts. `HF_ENDPOINT` in this
 * process still wins inside `resolveHuggingFaceEndpoint`; a `.env` one is
 * pushed in its place, which puts it exactly between the two.
 */
export function syncHfEndpoint(src: HfMirrorSources): HfMirrorState {
  const state = hfMirrorState(src);
  const fromDotenv = dotenvEndpoint(src);
  setDefaultHuggingFaceEndpoint(fromDotenv ?? huggingFaceEndpointFromConfig(src.config));
  return state;
}

export type HfMirrorInput = { ok: true; value: string } | { ok: false; error: string };

/** The field's text, as the value to write, or the sentence saying why not. */
export function hfMirrorInput(raw: unknown): HfMirrorInput {
  if (typeof raw !== "string") return { ok: false, error: "mirror address required" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: DEFAULT_HF_ENDPOINT };
  if (trimmed.length > 2048) return { ok: false, error: "That address is too long." };
  const normalized = normalizeHuggingFaceEndpoint(trimmed);
  if (!normalized) {
    return {
      ok: false,
      error: "Type an address that starts with http:// or https://, such as https://hf-mirror.com. Leave it empty to use huggingface.co.",
    };
  }
  return { ok: true, value: normalized };
}

export interface HfMirrorDeps {
  sources: () => HfMirrorSources;
  /** configSetPath: the whole-file write under the config lock. */
  write: (key: string, value: string) => Promise<{ ok: boolean; error?: string | null }>;
}

export type HfMirrorWriteResult = { ok: true; state: HfMirrorState } | { ok: false; error: string };

/** Validate, write, re-read, push in. Nothing is written when the text is refused. */
export async function writeHfMirror(raw: unknown, deps: HfMirrorDeps): Promise<HfMirrorWriteResult> {
  const input = hfMirrorInput(raw);
  if (!input.ok) return input;
  const res = await deps.write(HF_ENDPOINT_KEY, input.value);
  if (!res.ok) return { ok: false, error: res.error || "could not save the mirror" };
  return { ok: true, state: syncHfEndpoint(deps.sources()) };
}
