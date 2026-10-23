/**
 * Whether an OpenAI-compatible base URL points at a server on this
 * machine or the local network (llama-server, vLLM, LM Studio and the
 * like): loopback, RFC 1918 and link-local IPv4, IPv6 unique-local and
 * link-local, `.local` / `.lan` / `.internal` / `.home.arpa` names and
 * single-label hosts. Such servers render the chat template themselves
 * and take its arguments (`chat_template_kwargs`); public endpoints may
 * reject a field they do not know, so they are never treated as local.
 */
export function isLocalServerUrl(url: string | undefined): boolean {
  if (!url) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host.length === 0) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") return true;
  const v4 = host.split(".");
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = v4.map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(":")) return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  if (!host.includes(".")) return true;
  return [".local", ".lan", ".internal", ".home.arpa"].some((suffix) => host.endsWith(suffix));
}
