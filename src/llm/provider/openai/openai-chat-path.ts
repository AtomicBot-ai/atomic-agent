import { normalizeOpenAiBaseUrl } from "./normalize-openai-base-url.js";

/**
 * Roots that serve chat completions at `<root>/chat/completions`, with no
 * `/v1` in front.
 *
 * Every OpenAI-compatible call site appends `/v1/...` to the stored root,
 * and for every preset but one that is where chat lives. Perplexity
 * serves it at `https://api.perplexity.ai/chat/completions` and answers
 * 404 under `/v1`, while its model list is the usual `/v1/models`
 * (checked with a dummy key on 2026-10-02: `/chat/completions` and
 * `/v1/models` answer 401, `/v1/chat/completions` and `/models` 404).
 * So the exception is the chat route alone, for the bare root alone:
 * `https://api.perplexity.ai/router` is Perplexity's Router API, a
 * different root that keeps the convention.
 */
const CHAT_AT_ROOT_HOSTS: ReadonlySet<string> = new Set(["api.perplexity.ai"]);

/**
 * The path prefix of `<root>`'s chat route: `/v1`, or `""` for a root
 * listed above. Read off the URL rather than stored on the entry, so a
 * provider saved before this rule existed starts working unchanged.
 */
export function openAiChatPathPrefix(baseUrl: string): "" | "/v1" {
  let url: URL;
  try {
    url = new URL(normalizeOpenAiBaseUrl(baseUrl));
  } catch {
    return "/v1";
  }
  const bareRoot = url.pathname === "" || url.pathname === "/";
  if (bareRoot && CHAT_AT_ROOT_HOSTS.has(url.hostname.toLowerCase())) return "";
  return isVertexOpenApiRoot(url) ? "" : "/v1";
}

/**
 * Google Vertex AI's OpenAI-compatible root,
 * `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/endpoints/openapi`
 * (the `global` location drops the region from the host). The version is
 * already in the path, so chat is `<root>/chat/completions`: probed
 * 2026-11-13 with a bogus token, that answers 401 asking for an OAuth
 * access token while `<root>/v1/chat/completions` is a 404.
 */
function isVertexOpenApiRoot(url: URL): boolean {
  return (
    /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/i.test(url.hostname) &&
    /\/endpoints\/openapi$/i.test(url.pathname)
  );
}
