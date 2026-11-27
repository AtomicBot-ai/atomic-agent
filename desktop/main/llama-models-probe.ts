/* ATO-2012: a llama.cpp server can pass /health with no model in it. A
   router (`llama-server` started with no `-m`, models added later) answers
   /health with {"status":"ok"} and serves an empty model list, so the
   first-run address check said yes to a server that cannot answer a chat.

   After a passing /health, llamaProbe (agent-cli.ts) asks /v1/models once
   more and keeps what it learns as flags on the probe. The second ask can
   only ADD a flag: a timeout, a refused socket, a 404 or a body it cannot
   read leaves the passing verdict exactly as it was. */

export interface LlamaModelsFlags {
  /** /v1/models answered with an empty `data` list. */
  noModels?: true;
  /** /v1/models answered 503 "Loading model": the server is still reading its file. */
  loading?: true;
}

/** llama.cpp's 503 while it loads: {"error":{"message":"Loading model","code":503}}. */
function saysLoadingModel(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const error = (parsed as { error?: unknown }).error;
      const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error;
      if (typeof message === "string") return message.toLowerCase().includes("loading model");
    }
  } catch { /* not JSON: fall through to the raw text */ }
  return text.toLowerCase().includes("loading model");
}

/** Pure: what one /v1/models answer says about the models in the server. */
export function readLlamaModelsAnswer(status: number, text: string): LlamaModelsFlags {
  if (status === 503) return saysLoadingModel(text) ? { loading: true } : {};
  if (status < 200 || status >= 300) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const data = (parsed as { data?: unknown }).data;
    // Only an explicit empty list counts. A body without `data` is a server we do not know.
    return Array.isArray(data) && data.length === 0 ? { noModels: true } : {};
  } catch {
    return {};
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) =>
  Promise<{ status: number; text(): Promise<string> }>;

export const LLAMA_MODELS_TIMEOUT_MS = 3000;

/** One GET of `modelsUrl` with the probe's own headers. Never throws: any failure is "no flags". */
export async function askLlamaModels(
  modelsUrl: string,
  headers: Record<string, string>,
  timeoutMs = LLAMA_MODELS_TIMEOUT_MS,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LlamaModelsFlags> {
  try {
    const response = await fetchImpl(modelsUrl, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text().catch(() => "");
    return readLlamaModelsAnswer(response.status, text);
  } catch {
    return {};
  }
}
