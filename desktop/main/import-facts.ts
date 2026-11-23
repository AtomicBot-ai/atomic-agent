/**
 * ATO-1629 / ATO-1061 (desktop half): "Here is what I learned about you".
 *
 * After the chats of a Claude export are moved in (and, for ChatGPT, on its
 * own), the agent reads the person's own messages and lists facts about
 * them; the person ticks the ones to keep and saves. The agent does the
 * work behind `/api/import/facts/*` (ATO-1617, src/http/route-import-facts.ts):
 *
 *   POST   start            {source, path, engine?} → {job}
 *   GET    jobs/{id}        → {job}  (candidates once it ended)
 *   POST   jobs/{id}/stop   DELETE jobs/{id}
 *   POST   jobs/{id}/save   {approvedIds} → {saved, skipped, conflicts, failed, receiptId}
 *
 * The local model reads by default (Nadya's decision on ATO-1617). A cloud
 * model only when this run's box is ticked; then the body carries
 * `cloudConsent: true` and nothing else ever does.
 *
 * The export is a file on this computer, so a remote agent (one on another
 * machine) is refused before anything is sent: it could not open the path.
 *
 * Pure: no Electron, no network of its own (the client is passed in), so
 * test/import-facts-main.test.mjs reads it from `out/`. import-facts-ipc.ts
 * registers the handlers. Nothing here logs or counts message text: the
 * analytics hook gets counts only.
 */

import { isAbsolute } from "node:path";

import { isLocalServerUrl } from "./local-server-url.js";

export type FactsSource = "claude" | "chatgpt";
export type FactsJobState = "reading" | "extracting" | "done" | "stopped" | "failed";

export interface FactCandidateView {
  id: string;
  kind: "profile" | "note";
  key: string | null;
  value: string;
  pinned: boolean;
  quote: string;
}

export interface FactsJobView {
  id: string;
  source: FactsSource;
  state: FactsJobState;
  providerId: string;
  local: boolean;
  chunksDone: number;
  chunksTotal: number;
  found: number;
  failedChunks: number;
  candidates: FactCandidateView[] | null;
  error: string | null;
}

export interface FactsSaveView {
  saved: number;
  skipped: number;
  conflicts: number;
  failed: number;
  receiptId: string | null;
}

export interface CloudChoice {
  id: string;
  label: string;
}

export const FACTS_JOB_STATES: readonly FactsJobState[] = ["reading", "extracting", "done", "stopped", "failed"];
export const FACTS_ENDED: readonly FactsJobState[] = ["done", "stopped", "failed"];

/** Said when the agent runs on another computer: it cannot open a file on this one. */
export const FACTS_REMOTE_TEXT =
  "The agent runs on another computer, so it cannot read an export file from this one. Connect to the agent on this computer to bring in facts about you.";
const NOT_RUNNING_TEXT = "The agent is not running. Start it and try again.";
const OLD_AGENT_TEXT = "This agent cannot read facts from an export yet. Update Atomic Agent and try again.";

/** `/api/capabilities` → `agent.importFacts`. An older agent has no such key. */
export function importFactsSupported(caps: unknown): boolean {
  const agent = caps && typeof caps === "object" ? (caps as { agent?: unknown }).agent : null;
  return !!agent && typeof agent === "object" && (agent as { importFacts?: unknown }).importFacts === true;
}

/** What the window asks to start, checked; `body` is the agent's start body. */
export function factsStartBody(input: unknown): { ok: true; body: Record<string, unknown>; local: boolean } | { ok: false; error: string } {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (i["source"] !== "claude" && i["source"] !== "chatgpt") return { ok: false, error: "Choose Claude or ChatGPT first." };
  const path = typeof i["path"] === "string" ? i["path"].trim() : "";
  if (!path || !isAbsolute(path)) return { ok: false, error: "Choose the export .zip first." };
  const cloud = i["cloud"];
  if (cloud === undefined || cloud === null || cloud === false) {
    return { ok: true, local: true, body: { source: i["source"], path, engine: { kind: "local" } } };
  }
  const c = (typeof cloud === "object" ? cloud : {}) as Record<string, unknown>;
  const provider = typeof c["provider"] === "string" ? c["provider"] : "";
  if (!provider) return { ok: false, error: "Choose the cloud model to use." };
  // Only the person's tick on this run is consent; anything else is refused here, before the agent.
  if (c["consent"] !== true) return { ok: false, error: "Tick the box to send your chats to the cloud model, or use the local one." };
  return { ok: true, local: false, body: { source: i["source"], path, engine: { kind: "cloud", provider, cloudConsent: true } } };
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseCandidate(raw: unknown): FactCandidateView | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c["id"] !== "string" || !c["id"] || typeof c["value"] !== "string" || !c["value"].trim()) return null;
  const kind = c["kind"] === "note" ? "note" : "profile";
  return {
    id: c["id"],
    kind,
    key: kind === "profile" && typeof c["key"] === "string" && c["key"] ? c["key"] : null,
    value: c["value"].trim(),
    pinned: c["pinned"] === true,
    quote: str(c["quote"]).trim(),
  };
}

/** `{job}` from the start and job routes, or the job itself; null when it is not one. */
export function parseFactsJob(raw: unknown): FactsJobView | null {
  const wrapped = raw && typeof raw === "object" && "job" in (raw as object) ? (raw as { job: unknown }).job : raw;
  if (!wrapped || typeof wrapped !== "object") return null;
  const j = wrapped as Record<string, unknown>;
  if (typeof j["id"] !== "string" || !j["id"]) return null;
  const state = FACTS_JOB_STATES.includes(j["state"] as FactsJobState) ? (j["state"] as FactsJobState) : null;
  if (!state) return null;
  const progress = (j["progress"] && typeof j["progress"] === "object" ? j["progress"] : {}) as Record<string, unknown>;
  const list = Array.isArray(j["candidates"]) ? (j["candidates"] as unknown[]) : null;
  const candidates = list ? list.map(parseCandidate).filter((c): c is FactCandidateView => c !== null) : null;
  const total = count(progress["chunksTotal"]);
  return {
    id: j["id"],
    source: j["source"] === "chatgpt" ? "chatgpt" : "claude",
    state,
    providerId: str(j["providerId"]),
    local: j["local"] !== false,
    chunksDone: Math.min(count(progress["chunksDone"]), total || Number.MAX_SAFE_INTEGER),
    chunksTotal: total,
    found: candidates ? candidates.length : count(progress["candidates"]),
    failedChunks: count(j["failedChunks"]),
    candidates,
    error: typeof j["error"] === "string" && j["error"] ? j["error"] : null,
  };
}

export function parseFactsSave(raw: unknown): FactsSaveView | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["saved"] !== "number") return null;
  return {
    saved: count(r["saved"]),
    skipped: count(r["skipped"]),
    conflicts: Array.isArray(r["conflicts"]) ? r["conflicts"].length : 0,
    failed: count(r["failed"]),
    receiptId: typeof r["receiptId"] === "string" ? r["receiptId"] : null,
  };
}

/** The agent's error answer in the window's words. The body is openai-style `{error:{message, code}}`. */
export function factsErrorText(status: number, body: unknown): string {
  const err = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
  const e = (err && typeof err === "object" ? err : {}) as { message?: unknown; code?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  const words: Record<string, string> = {
    cloud_consent_required: "Tick the box to send your chats to the cloud model, or use the local one.",
    no_local_model: "No local model is set up. Start a local model in Settings › Models, or tick the box to use a cloud model for this import.",
    unknown_provider: "That model is not set up on the agent. Choose another one.",
    not_cloud: "That model runs on this computer. Untick the cloud box to use it.",
    busy: "The agent is already reading an export. Wait for it to finish, or stop it.",
    not_ready: "The agent is still reading. Save once it is done.",
    not_found: "The agent no longer has this import. Start it again.",
  };
  if (code && words[code]) return words[code];
  // An agent from before the routes answers its unknown-route 404 with no code.
  if (status === 404) return OLD_AGENT_TEXT;
  if (status === 400 && message) return "The agent could not read that: " + message;
  return message || "The agent answered HTTP " + status + ".";
}

/** Plain names for the ids the presets use; anything else keeps its id. */
const PROVIDER_NAMES: Record<string, string> = {
  openrouter: "OpenRouter", anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", groq: "Groq",
  deepseek: "DeepSeek", mistral: "Mistral", together: "Together AI", xai: "xAI", aimlapi: "AI/ML API",
  cerebras: "Cerebras", fireworks: "Fireworks", moonshot: "Moonshot", perplexity: "Perplexity",
  dashscope: "Alibaba Cloud", nous: "Nous", novita: "Novita",
};

/**
 * The cloud models the person could pick, from `GET /api/config`: every
 * provider that is not on this machine or this network (the agent's own
 * test, isLocalProviderEntry), the active one first.
 */
export function cloudChoices(config: unknown): CloudChoice[] {
  const llm = config && typeof config === "object" ? (config as { llm?: unknown }).llm : null;
  const l = (llm && typeof llm === "object" ? llm : {}) as { providers?: unknown; activeTextProvider?: unknown };
  const list = Array.isArray(l.providers) ? (l.providers as unknown[]) : [];
  const out: CloudChoice[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    const id = typeof p["id"] === "string" ? p["id"] : "";
    if (!id || p["kind"] === "llama-server") continue;
    const url = typeof p["baseUrl"] === "string" ? p["baseUrl"] : typeof p["url"] === "string" ? p["url"] : undefined;
    if (isLocalServerUrl(url)) continue;
    const named = typeof p["label"] === "string" && p["label"] ? p["label"] : typeof p["name"] === "string" && p["name"] ? p["name"] : "";
    out.push({ id, label: named || PROVIDER_NAMES[id] || id });
  }
  const active = typeof l.activeTextProvider === "string" ? l.activeTextProvider : "";
  out.sort((a, b) => (a.id === active ? -1 : b.id === active ? 1 : 0));
  return out;
}

/** The ids the person ticked, kept only when the job really listed them. */
export function factsApprovedIds(job: FactsJobView | null, ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const known = new Set((job?.candidates ?? []).map((c) => c.id));
  const seen = new Set<string>();
  for (const id of ids) if (typeof id === "string" && known.has(id)) seen.add(id);
  return [...seen];
}

/* ---------- the handlers import-facts-ipc.ts registers ---------- */

type Route = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; body: unknown }>;

export interface ImportFactsDeps {
  client: {
    status: { state: string };
    isRemote: boolean;
    capabilities: () => Promise<unknown>;
    config: () => Promise<unknown>;
    importFactsRoute: Route;
  };
  /** Counts only (import_facts). */
  onFound?: (info: { source: FactsSource; local: boolean; state: FactsJobState; found: number }) => void;
  onSaved?: (info: { source: FactsSource; local: boolean; state: FactsJobState; found: number; saved: number; skipped: number }) => void;
}

type Fail = { ok: false; error: string; remote?: boolean };

export function createImportFactsHandlers(deps: ImportFactsDeps) {
  const c = deps.client;
  /** The last view of each job this window started: what save checks the ticks against. */
  const jobs = new Map<string, FactsJobView>();
  const reported = new Set<string>();
  const ready = (): Fail | null => {
    if (c.isRemote) return { ok: false, remote: true, error: FACTS_REMOTE_TEXT };
    if (c.status.state !== "connected") return { ok: false, error: NOT_RUNNING_TEXT };
    return null;
  };
  const call = async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ ok: true; body: unknown } | Fail> => {
    try {
      const res = await c.importFactsRoute(method, path, body);
      if (res.status >= 200 && res.status < 300) return { ok: true, body: res.body };
      return { ok: false, error: factsErrorText(res.status, res.body) };
    } catch (err) {
      return { ok: false, error: "Could not reach the agent: " + (err instanceof Error ? err.message : String(err)) };
    }
  };
  const remember = (job: FactsJobView): void => {
    jobs.set(job.id, job);
    if (FACTS_ENDED.includes(job.state) && !reported.has(job.id)) {
      reported.add(job.id);
      deps.onFound?.({ source: job.source, local: job.local, state: job.state, found: job.found });
    }
  };
  const idPath = (id: unknown): string | null => (typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? encodeURIComponent(id) : null);

  return {
    /** Whether to offer the step, and what the model choice shows. */
    async info(): Promise<{ ok: true; supported: boolean; remote: boolean; cloud: CloudChoice[] } | Fail> {
      if (c.isRemote) return { ok: true, supported: false, remote: true, cloud: [] };
      if (c.status.state !== "connected") return { ok: false, error: NOT_RUNNING_TEXT };
      const [caps, config] = await Promise.all([c.capabilities().catch(() => null), c.config().catch(() => null)]);
      return { ok: true, supported: importFactsSupported(caps), remote: false, cloud: cloudChoices(config) };
    },
    async start(input: unknown): Promise<{ ok: true; job: FactsJobView } | Fail> {
      const notReady = ready();
      if (notReady) return notReady;
      const checked = factsStartBody(input);
      if (!checked.ok) return checked;
      const res = await call("POST", "start", checked.body);
      if (!res.ok) return res;
      const job = parseFactsJob(res.body);
      if (!job) return { ok: false, error: "The agent did not return an import." };
      remember(job);
      return { ok: true, job };
    },
    async job(id: unknown): Promise<{ ok: true; job: FactsJobView } | Fail> {
      const p = idPath(id);
      if (!p) return { ok: false, error: "No such import." };
      const notReady = ready();
      if (notReady) return notReady;
      const res = await call("GET", "jobs/" + p);
      if (!res.ok) return res;
      const job = parseFactsJob(res.body);
      if (!job) return { ok: false, error: "The agent did not return the import." };
      remember(job);
      return { ok: true, job };
    },
    async stop(id: unknown): Promise<{ ok: true } | Fail> {
      const p = idPath(id);
      if (!p) return { ok: false, error: "No such import." };
      const res = await call("POST", "jobs/" + p + "/stop", {});
      return res.ok ? { ok: true } : res;
    },
    /** Drops the job and its candidates on the agent (after saving, or when the step is closed). */
    async forget(id: unknown): Promise<{ ok: true } | Fail> {
      const p = idPath(id);
      if (!p) return { ok: false, error: "No such import." };
      jobs.delete(id as string);
      const res = await call("DELETE", "jobs/" + p);
      return res.ok ? { ok: true } : res;
    },
    async save(id: unknown, ids: unknown): Promise<{ ok: true; result: FactsSaveView } | Fail> {
      const p = idPath(id);
      if (!p) return { ok: false, error: "No such import." };
      const notReady = ready();
      if (notReady) return notReady;
      const job = jobs.get(id as string) ?? null;
      const approvedIds = factsApprovedIds(job, ids);
      // Nothing ticked, nothing saved: the agent is not asked.
      if (!approvedIds.length) return { ok: true, result: { saved: 0, skipped: 0, conflicts: 0, failed: 0, receiptId: null } };
      const res = await call("POST", "jobs/" + p + "/save", { approvedIds });
      if (!res.ok) return res;
      const result = parseFactsSave(res.body);
      if (!result) return { ok: false, error: "The agent did not say what it saved." };
      if (job) deps.onSaved?.({ source: job.source, local: job.local, state: job.state, found: job.found, saved: result.saved, skipped: result.skipped });
      return { ok: true, result };
    },
  };
}
