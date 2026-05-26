export type OpenAiHttpDeps = {
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
};

export function buildOpenAiHeaders(
  deps: OpenAiHttpDeps,
  stream: boolean,
): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: stream ? "text/event-stream" : "application/json",
    authorization: `Bearer ${deps.apiKey}`,
    ...deps.extraHeaders,
  };
}

export async function openAiGetJson(
  deps: OpenAiHttpDeps,
  path: string,
): Promise<Record<string, unknown>> {
  const res = await openAiFetch(deps, path, null, {}, false, "GET");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai provider ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function openAiPostJson(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown>,
  request: { signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const res = await openAiFetch(deps, path, body, request, false, "POST");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai provider ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export async function openAiFetch(
  deps: OpenAiHttpDeps,
  path: string,
  body: Record<string, unknown> | null,
  request: { signal?: AbortSignal },
  stream: boolean,
  method: "GET" | "POST" = "POST",
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.requestTimeoutMs);
  if (request.signal) {
    request.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }
  try {
    return await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method,
      headers: buildOpenAiHeaders(deps, stream),
      ...(body && method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
