/**
 * Pure mappings from what the app already knows (results, error strings,
 * sizes) to the fixed enums the catalogue allows. Error text is READ here to
 * pick an enum and never leaves this file.
 */

import { PROVIDER_PRESETS, SUPERVISOR_KINDS } from "./catalog.js";

/** Provider preset id, or `custom` for anything a user named themselves. */
export function presetOf(id: unknown): string {
  return typeof id === "string" && (PROVIDER_PRESETS as readonly string[]).includes(id) ? id : "custom";
}

/** comfortable / tight / over, from the catalogue's RAM figures when known, else from the file size. */
export function fitFor(
  hostRamGb: number,
  m: { sizeGb?: number | null; minRamGb?: number | null; recommendedRamGb?: number | null },
): "comfortable" | "tight" | "over" | null {
  if (!(hostRamGb > 0)) return null;
  const min = m.minRamGb ?? null;
  const rec = m.recommendedRamGb ?? null;
  if (min !== null && rec !== null && min > 0 && rec > 0) {
    if (hostRamGb >= rec) return "comfortable";
    if (hostRamGb >= min) return "tight";
    return "over";
  }
  const size = m.sizeGb ?? null;
  if (size === null || !(size > 0)) return null;
  // ramWarningFor (huggingface.ts) warns once the weights outgrow RAM.
  if (size > hostRamGb) return "over";
  return size > hostRamGb * 0.6 ? "tight" : "comfortable";
}

/** `Q4_K_M`, `IQ3_XXS`, `F16`… out of a GGUF file name (an Unsloth `UD-` prefix dropped), else `unknown`. */
export function quantOf(filename: unknown): string {
  if (typeof filename !== "string") return "unknown";
  const base = filename.split(/[\\/]/).pop() ?? "";
  const m = /(?:^|[-_.])(?:UD-)?(I?Q\d(?:_[A-Z0-9]+){0,3}|BF16|F16|F32|MXFP4)(?=[-_.]|$)/i.exec(base);
  return m ? m[1]!.toUpperCase() : "unknown";
}

/** provider_key_checked.result from verifyProviderKey's answer. */
export function keyCheckResult(res: { ok?: boolean; checked?: boolean; status?: number; keyChars?: boolean } | null | undefined): {
  result: "ok" | "rejected" | "unreachable" | "payment_required";
  http_status: number | null;
} {
  const status = typeof res?.status === "number" ? res.status : null;
  if (res?.ok) return { result: "ok", http_status: status };
  if (res?.keyChars) return { result: "rejected", http_status: null };
  if (status === 401 || status === 403) return { result: "rejected", http_status: status };
  if (status === 402) return { result: "payment_required", http_status: status };
  return { result: "unreachable", http_status: status };
}

/** hf_lookup.result from the lookup's thrown message (huggingface.ts). */
export function hfLookupResult(message: string): "unreachable" | "gated" | "not_found" | "no_gguf" | "none_servable" | "other" {
  // huggingface.co or the mirror that stands in for it (huggingface.ts names the host).
  if (/^Could not reach \S+:/i.test(message)) return "unreachable";
  if (/returned (401|403)/.test(message)) return "gated";
  if (/returned 404/.test(message)) return "not_found";
  if (/No \.gguf files/i.test(message)) return "no_gguf";
  if (/none this agent can serve/i.test(message)) return "none_servable";
  return "other";
}

/** model_download_finished.reason from a failed pull. */
export function downloadFailReason(error: unknown, sawProgress: boolean): "offline" | "busy" | "exited" | "disk_full" | "http_error" | "no_progress" | "other" {
  const e = typeof error === "string" ? error : "";
  if (/ENOSPC|no space left|disk (is )?full|not enough (disk|space)/i.test(e)) return "disk_full";
  if (/already running|another download/i.test(e)) return "busy";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|offline|network|could not reach|fetch failed/i.test(e)) return "offline";
  if (/HTTP \d{3}|status \d{3}|\b(4\d\d|5\d\d)\b/.test(e)) return "http_error";
  if (!sawProgress) return "no_progress";
  if (/exit|exited|code \d+|signal/i.test(e)) return "exited";
  return "other";
}

/** DaemonEffect (`start-failed`) → the catalogue's underscore spelling. */
export function daemonEffect(d: unknown): string | undefined {
  return typeof d === "string" ? d.replace(/-/g, "_") : undefined;
}

/** backend_switched.result + refusal from a SwitchResult. */
export function switchOutcome(res: {
  ok?: boolean; needsProvider?: boolean; needsKey?: boolean; keyInvalid?: boolean; needsModel?: boolean;
  needsChatModel?: boolean; needsDownload?: boolean; refusal?: string; error?: string;
} | null | undefined): { result: "ok" | "refused" | "failed" | "timeout"; refusal: string | null } {
  if (!res) return { result: "failed", refusal: null };
  if (res.ok) return { result: "ok", refusal: null };
  if (res.keyInvalid) return { result: "refused", refusal: "key_invalid" };
  if (res.needsKey) return { result: "refused", refusal: "needs_key" };
  if (res.needsProvider) return { result: "refused", refusal: "needs_provider" };
  if (res.needsChatModel) return { result: "refused", refusal: "needs_chat_model" };
  if (res.needsDownload) return { result: "refused", refusal: "needs_download" };
  if (res.needsModel) return { result: "refused", refusal: "needs_model" };
  const text = `${res.refusal ?? ""} ${res.error ?? ""}`;
  if (/timed? ?out|timeout/i.test(text)) return { result: "timeout", refusal: null };
  if (res.refusal !== undefined) {
    if (/turn/i.test(text) && /running|in flight|progress/i.test(text)) return { result: "refused", refusal: "turn_running" };
    if (/switch/i.test(text) && /running|in flight|progress|already/i.test(text)) return { result: "refused", refusal: "switch_running" };
    if (/no (cloud )?provider|second provider/i.test(text)) return { result: "refused", refusal: "no_provider" };
    return { result: "refused", refusal: "other" };
  }
  return { result: "failed", refusal: null };
}

/** speech.ts emit `{type:"error", code}` → voice_used.error. */
export function voiceError(code: unknown): "spawn" | "too_long" | "other" {
  if (code === "spawn") return "spawn";
  if (code === "too-long") return "too_long";
  return "other";
}

/**
 * ATO-773: the line daemon-watch describeFault picked from the model server's
 * log, as a code. The line can hold paths and model names; only the code
 * leaves this file. No line at all is null.
 */
export function engineFault(line: unknown): "oom" | "port_in_use" | "load_failed" | "missing_lib" | "crash" | "unknown" | null {
  if (typeof line !== "string" || !line.trim()) return null;
  if (/library not loaded|cannot open shared object|shared librar|image not found|\.(dll|dylib|so)\b/i.test(line)) return "missing_lib";
  if (/out of memory|failed to allocate|insufficient memory|\boom\b/i.test(line)) return "oom";
  if (/address already in use|couldn'?t bind|EADDRINUSE/i.test(line)) return "port_in_use";
  if (/error loading model|failed to (load|initiali[sz]e)/i.test(line)) return "load_failed";
  if (/segmentation fault|abort|SIGSEGV|SIGABRT/i.test(line)) return "crash";
  return "unknown";
}

/**
 * ATO-278: why the local model server did not start, or died, as a code
 * (catalog-values BACKEND_FAIL_REASONS). `error` is the start's own error text
 * (and its stderr tail), `faultLine` the line daemon-watch describeFault picked
 * from the server's log. Both can hold paths and model names: they are read
 * here to pick the code and never leave this file.
 */
export function backendFailReason(error: unknown, faultLine: unknown):
  "oom" | "port_in_use" | "load_failed" | "missing_lib" | "crash" | "timeout" | "exited_after_ready" | "other" {
  const text = typeof error === "string" ? error : "";
  // agent-cli modelsStart: the server came up, then stopped answering while the start waited on it.
  if (/stopped answering while it was starting/i.test(text)) return "exited_after_ready";
  // agent-cli cli(): the app's own time limit on `models start` (execFile killed it).
  if (/did not answer `[^`]*` within|timed? ?out|time limit|ETIMEDOUT/i.test(text)) return "timeout";
  for (const line of [text, faultLine]) {
    const fault = engineFault(line);
    if (fault && fault !== "unknown") return fault;
  }
  return "other";
}

/**
 * ATO-773: `local_backend_supervised` props from a supervisor notice
 * (daemon-supervisor SupervisorNotice), or null for one that is not sent
 * (`clear`, ATO-244's CPU word on the same channel). `quickDeaths` is the
 * supervisor's count now, for the kinds whose notice carries none. The
 * notice's `reason` and `error` are text and are never read.
 */
export function supervisedProps(notice: unknown, quickDeaths: number | null): {
  kind: string; quick_deaths: number | null; after_ms: number | null; fault: string | null;
} | null {
  const n = (notice && typeof notice === "object" ? notice : {}) as {
    kind?: unknown; quickDeaths?: unknown; deaths?: unknown; afterMs?: unknown; fault?: unknown;
  };
  const kind = typeof n.kind === "string" && (SUPERVISOR_KINDS as readonly string[]).includes(n.kind) ? n.kind : null;
  if (!kind) return null;
  const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    kind,
    quick_deaths: kind === "gave_up" ? count(n.deaths) : kind === "restarting" ? count(n.quickDeaths) : count(quickDeaths),
    after_ms: kind === "restarted" ? count(n.afterMs) : null,
    fault: kind === "restart_failed" || kind === "gave_up" ? engineFault(n.fault) : null,
  };
}
