/**
 * Whether an OpenAI-compatible base URL is a service that refuses a tool
 * loop unless every assistant tool call carries its `reasoning_content`
 * back (ATO-1397).
 *
 * DeepSeek's thinking mode answers a follow-up request whose assistant
 * `tool_calls` message lacks the field with a 400: "The
 * `reasoning_content` in the thinking mode must be passed back to the
 * API". Other public endpoints may reject a field they do not know, so
 * only the hosts that ask for it get it.
 */
const REASONING_ECHO_HOSTS = ["api.deepseek.com"] as const;

export function requiresReasoningEcho(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return REASONING_ECHO_HOSTS.some(
    (known) => host === known || host.endsWith(`.${known}`),
  );
}
