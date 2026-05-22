/**
 * Environment-lock helpers for the memory benchmark campaign.
 *
 * The campaign compares many memory profiles against the **same**
 * llama-server / chat model / embedding model / judge model. To make
 * results reproducible across operator machines and dates, every
 * campaign run must pin those versions in `reports/<run>/environment.json`.
 *
 * `captureEnvironmentSnapshot()` collects what is knowable at runtime:
 *
 *  - `atomic-agent` version (from `package.json`).
 *  - Node + platform metadata.
 *  - Chat llama-server `n_ctx` + model id (from `/props`).
 *  - Embedding daemon model + URL when reachable.
 *  - Git provenance (HEAD SHA + branch + dirty bit + number of dirty
 *    files). Defensive: missing `git` or non-repo checkouts fold into
 *    null fields.
 *  - Judge model name (from `ATOMIC_AGENT_JUDGE_MODEL`, defaults to
 *    `openai/gpt-5.4-mini`).
 *  - Fixed sampling knobs that the harness sends on every completion
 *    (`temperature`, `top_p`, `top_k`, `seed`). Bumping these here
 *    must coincide with a re-run of every baseline — that is the
 *    whole point of the lock.
 *
 * The snapshot is **descriptive**, not prescriptive — it records what
 * we observed, not what we enforce. The companion stop-gate is a
 * reproducibility check (`scripts/lock-environment.mjs`) that runs the
 * same scenario twice on the same profile and asserts the deltas are
 * within ±1 pp on the key metrics (see PLAN.md Phase 0).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

export interface EnvironmentSnapshot {
  capturedAt: string;
  agentVersion: string;
  /**
   * Git provenance of the source tree at capture time. `dirty: true`
   * means the working tree had uncommitted changes — the snapshot is
   * still recorded (we never block honest captures), but the campaign
   * scorecard MUST refuse to publish results from a dirty tree.
   */
  git: {
    sha: string | null;
    shortSha: string | null;
    branch: string | null;
    dirty: boolean;
    dirtyFiles: number;
  };
  node: {
    version: string;
    platform: string;
    arch: string;
  };
  llama: {
    chatUrl: string;
    chatModelId: string | null;
    chatNCtx: number | null;
    embeddingUrl: string | null;
    embeddingModelId: string | null;
    serverVersion: string | null;
  };
  judge: {
    model: string;
    url: string;
    disabled: boolean;
  };
  sampling: {
    temperature: number;
    topP: number;
    topK: number;
    seed: number;
    cachePrompt: boolean;
  };
}

/**
 * Capture the current git revision of the source tree. Each step is
 * defensive — a missing `git` binary or a non-repo checkout folds into
 * `null` fields so the snapshot stays writeable on CI runners that
 * shallow-clone or strip `.git` metadata.
 */
export function captureGitProvenance(): EnvironmentSnapshot["git"] {
  const sha = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  const dirtyFiles =
    status === null
      ? 0
      : status
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0).length;
  return {
    sha,
    shortSha: sha ? sha.slice(0, 12) : null,
    branch: branch === "HEAD" ? null : branch,
    dirty: dirtyFiles > 0,
    dirtyFiles,
  };
}

function runGit(args: readonly string[]): string | null {
  try {
    const r = spawnSync("git", args as string[], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.status !== 0) return null;
    const out = (r.stdout ?? "").trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Read the agent `version` from `package.json`. */
export function readAgentVersion(): string {
  const path = resolve(REPO_ROOT, "package.json");
  if (!existsSync(path)) return "unknown";
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return typeof json.version === "string" ? json.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Fixed sampling knobs the campaign uses for every LLM call. The
 * values must match `createLlmComplete` defaults in
 * `harness/llm-client.ts` so the environment snapshot is honest about
 * what runners actually sent on the wire. Mutating these constants
 * requires regenerating every baseline (the v2 vs competitor charts
 * become incomparable otherwise).
 */
export const CAMPAIGN_SAMPLING = {
  temperature: 0.2,
  topP: 0.95,
  topK: 40,
  /**
   * The campaign uses a fixed seed so two identical runs produce the
   * same completion when the model is deterministic. llama.cpp accepts
   * `seed` on `/completion`; not every backend honours it
   * deterministically across rebuilds, which is exactly why we also
   * gate on a ±1 pp reproducibility test.
   */
  seed: 0xa70a1c,
  cachePrompt: true,
} as const;

interface LlamaPropsResponse {
  default_generation_settings?: { n_ctx?: number };
  n_ctx?: number;
  model_path?: string;
  build_info?: string;
}

async function fetchLlamaProps(
  url: string,
  signal?: AbortSignal,
): Promise<LlamaPropsResponse | null> {
  try {
    const r = await fetch(`${url.replace(/\/+$/, "")}/props`, { signal });
    if (!r.ok) return null;
    return (await r.json()) as LlamaPropsResponse;
  } catch {
    return null;
  }
}

function basenameNoExt(p: string | undefined): string | null {
  if (!p) return null;
  const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export interface CaptureOptions {
  chatUrl: string;
  embeddingUrl?: string | null;
  signal?: AbortSignal;
  /** Override for tests. */
  fetchProps?: (url: string) => Promise<LlamaPropsResponse | null>;
}

/**
 * Probe llama-server + judge env and return a serialisable snapshot.
 * The function never throws — every probe failure folds into a `null`
 * field so the snapshot is always writeable.
 */
export async function captureEnvironmentSnapshot(
  opts: CaptureOptions,
): Promise<EnvironmentSnapshot> {
  const fetchPropsImpl =
    opts.fetchProps ?? ((url: string) => fetchLlamaProps(url, opts.signal));

  const chatProps = await fetchPropsImpl(opts.chatUrl);
  const chatNCtx =
    chatProps?.default_generation_settings?.n_ctx ?? chatProps?.n_ctx ?? null;
  const chatModelId = basenameNoExt(chatProps?.model_path);
  const serverVersion = chatProps?.build_info ?? null;

  let embeddingModelId: string | null = null;
  if (opts.embeddingUrl) {
    const embProps = await fetchPropsImpl(opts.embeddingUrl);
    embeddingModelId = basenameNoExt(embProps?.model_path);
  }

  const judgeModel =
    process.env.ATOMIC_AGENT_JUDGE_MODEL ?? "openai/gpt-5.4-mini";
  const judgeUrl =
    process.env.ATOMIC_AGENT_JUDGE_URL ?? "https://openrouter.ai/api/v1";
  const judgeDisabled = process.env.ATOMIC_AGENT_JUDGE_DISABLED === "1";

  return {
    capturedAt: new Date().toISOString(),
    agentVersion: readAgentVersion(),
    git: captureGitProvenance(),
    node: {
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    llama: {
      chatUrl: opts.chatUrl,
      chatModelId,
      chatNCtx,
      embeddingUrl: opts.embeddingUrl ?? null,
      embeddingModelId,
      serverVersion,
    },
    judge: {
      model: judgeModel,
      url: judgeUrl,
      disabled: judgeDisabled,
    },
    sampling: {
      temperature: CAMPAIGN_SAMPLING.temperature,
      topP: CAMPAIGN_SAMPLING.topP,
      topK: CAMPAIGN_SAMPLING.topK,
      seed: CAMPAIGN_SAMPLING.seed,
      cachePrompt: CAMPAIGN_SAMPLING.cachePrompt,
    },
  };
}

/**
 * Compare two snapshots and return a list of diffs (empty array when
 * fully equal modulo `capturedAt`). Used by `scripts/lock-environment.mjs`
 * to detect drift between a baseline and the current run.
 */
export function diffSnapshots(
  a: EnvironmentSnapshot,
  b: EnvironmentSnapshot,
): Array<{ path: string; a: unknown; b: unknown }> {
  const diffs: Array<{ path: string; a: unknown; b: unknown }> = [];
  const compare = (path: string, av: unknown, bv: unknown): void => {
    if (path === "capturedAt") return;
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av)) {
      const keys = new Set([
        ...Object.keys(av as Record<string, unknown>),
        ...Object.keys(bv as Record<string, unknown>),
      ]);
      for (const k of keys) {
        compare(
          path ? `${path}.${k}` : k,
          (av as Record<string, unknown>)[k],
          (bv as Record<string, unknown>)[k],
        );
      }
      return;
    }
    if (av !== bv) diffs.push({ path, a: av, b: bv });
  };
  compare("", a, b);
  return diffs;
}
