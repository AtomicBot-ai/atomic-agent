import {
  CHATGPT_ACCOUNT_ID_HEADER,
  CHATGPT_CODEX_BASE_URL,
  CHATGPT_ORIGINATOR,
  chatgptAccountId,
} from "./chatgpt-codex.js";
import type { OAuthTokens } from "./oauth-types.js";

/**
 * Which model a fresh ChatGPT sign-in uses (ATO-1448, Nadya 18.11):
 * whatever the Codex CLI uses as its default today, not a name pinned here.
 *
 * Codex does not hardcode one either (openai/codex at ea6b64fd,
 * `codex-rs/models-manager/src/manager.rs`): it reads the catalog from the
 * backend's `GET {CHATGPT_CODEX_BASE_URL}/models?client_version=…`
 * (`codex-rs/codex-api/src/endpoint/models.rs`), sorts it by `priority`
 * (`build_available_models`), and the first model the picker shows
 * (`visibility: "list"`) is the default (`mark_default_by_picker_visibility`
 * in `codex-rs/protocol/src/openai_models.rs`; `default_model_from_available`).
 * With a ChatGPT sign-in the `supported_in_api` filter does not apply
 * (`ModelPreset::filter_by_auth`). The same is done here.
 *
 * When the backend cannot be asked, the fallback is the first model of
 * Codex's own bundled catalog (`codex-rs/models-manager/models.json`,
 * priority 1), as Codex falls back to that file.
 */
export const CHATGPT_FALLBACK_DEFAULT_MODEL = "gpt-6.2-sol";

/**
 * The `client_version` the catalog is asked for. The backend hides models
 * whose `minimal_client_version` is newer, so this tracks Codex's latest
 * release (rust-v0.169.1 on 18.11.2026), not this agent's own version.
 */
export const CHATGPT_MODELS_CLIENT_VERSION = "0.169.1";

export interface CodexCatalogModel {
  slug?: unknown;
  priority?: unknown;
  visibility?: unknown;
}

/** Codex's pick: lowest `priority`, first picker-visible, else first. `null` for an empty list. */
export function pickCodexDefaultModel(models: readonly CodexCatalogModel[]): string | null {
  const usable = models
    .filter((m): m is CodexCatalogModel & { slug: string } => typeof m.slug === "string" && m.slug.length > 0)
    .map((m, index) => ({ m, index }))
    .sort((a, b) => priorityOf(a.m) - priorityOf(b.m) || a.index - b.index)
    .map(({ m }) => m);
  const visible = usable.find((m) => m.visibility === "list");
  return (visible ?? usable[0])?.slug ?? null;
}

function priorityOf(m: CodexCatalogModel): number {
  return typeof m.priority === "number" && Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER;
}

export type ModelsFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface CodexDefaultModelOptions {
  tokens: OAuthTokens;
  fetch?: ModelsFetch;
  signal?: AbortSignal;
  /** Test seam. */
  baseUrl?: string;
}

/**
 * Codex's current default model for this sign-in, asked from the same
 * catalog endpoint Codex reads. Never throws: any failure (offline, an
 * unexpected body, no account id) gives {@link CHATGPT_FALLBACK_DEFAULT_MODEL}
 * with `source: "fallback"`.
 */
export async function codexDefaultModel(
  options: CodexDefaultModelOptions,
): Promise<{ model: string; source: "backend" | "fallback" }> {
  const fallback = { model: CHATGPT_FALLBACK_DEFAULT_MODEL, source: "fallback" as const };
  const accountId = chatgptAccountId(options.tokens);
  if (accountId === null) return fallback;
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ModelsFetch);
  const base = (options.baseUrl ?? CHATGPT_CODEX_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models?client_version=${encodeURIComponent(CHATGPT_MODELS_CLIENT_VERSION)}`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${options.tokens.accessToken}`,
        [CHATGPT_ACCOUNT_ID_HEADER]: accountId,
        originator: CHATGPT_ORIGINATOR,
        accept: "application/json",
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return fallback;
    const body = JSON.parse(await response.text()) as { models?: unknown };
    if (!Array.isArray(body.models)) return fallback;
    const picked = pickCodexDefaultModel(body.models as CodexCatalogModel[]);
    return picked === null ? fallback : { model: picked, source: "backend" };
  } catch {
    return fallback;
  }
}
