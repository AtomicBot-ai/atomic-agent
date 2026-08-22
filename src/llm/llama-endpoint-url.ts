/**
 * Join a llama-server endpoint path onto an operator-supplied base URL
 * without discarding the base's own path.
 *
 * Every llama.cpp call site used to build URLs with
 * `new URL("/health", base)`. A leading-slash path resolves against the
 * ORIGIN, so a server published behind a reverse-proxy path prefix
 * (`https://box/llama`) was probed at `https://box/health`, answered 404,
 * and the External pane reported the server as missing. The
 * OpenAI-compatible client concatenates strings instead, which is why the
 * exact same base URL works when pasted into that provider's field — the
 * asymmetry operators actually hit (stub-verified: the compat route logs
 * `GET /llama/v1/models`, the llama route logged `GET /health`).
 *
 * A trailing `/v1` is dropped first: operators paste the URL they already
 * gave the OpenAI-compatible provider, whose convention bakes `/v1` into
 * the base. llama.cpp's native endpoints live beside `/v1`, not under it,
 * mirroring what `normalizeOpenAiBaseUrl` does in the other direction.
 */
export function llamaEndpointUrl(base: string, endpointPath: string): string {
  const parsed = new URL(base);
  let basePath = parsed.pathname.replace(/\/+$/, "");
  if (basePath.toLowerCase().endsWith("/v1")) {
    basePath = basePath.slice(0, -"/v1".length);
  }
  // Query/fragment on a base URL are operator typos for our purposes;
  // carrying them into every endpoint would break llama.cpp routing.
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = `${basePath}${endpointPath}`;
  return parsed.toString();
}
