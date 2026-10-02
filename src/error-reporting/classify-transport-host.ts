import { PROVIDER_PRESETS } from "../llm/provider/presets/provider-presets.js";

/**
 * What a transport failure's endpoint host is, as a class — never the
 * host itself. A custom endpoint's hostname can name a company, a
 * person's machine, or an internal network, so only one of these four
 * words leaves the machine:
 *   - `localhost`   — loopback (`localhost`, `*.localhost`, 127.x, `::1`);
 *   - `private`     — RFC 1918 / link-local / ULA addresses, `.local`,
 *                     `.lan`, `.internal`, `.home.arpa`, single-label names;
 *   - `known_cloud` — a cloud provider API host the agent ships a preset
 *                     or built-in provider for;
 *   - `other`       — anything else (a custom public endpoint).
 */
export type TransportHostClass =
  | "localhost"
  | "private"
  | "known_cloud"
  | "other";

/**
 * Hosts of the built-in providers that are not presets. Mirrors
 * `DEFAULT_OPENROUTER_BASE`, `DEFAULT_AIMLAPI_BASE`, `DEFAULT_GEMINI_BASE`
 * and `OPENAI_COMPAT_DEFAULT_BASE_URL` (a test pins them), copied rather
 * than imported so this module does not pull in provider code.
 */
const BUILT_IN_CLOUD_HOSTS = [
  "openrouter.ai",
  "api.aimlapi.com",
  "generativelanguage.googleapis.com",
  "api.openai.com",
] as const;

/** Every known cloud API hostname (lower-case, no port). */
export const KNOWN_CLOUD_HOSTS: ReadonlySet<string> = new Set([
  ...BUILT_IN_CLOUD_HOSTS,
  ...PROVIDER_PRESETS.filter((p) => p.local !== true).flatMap((p) => {
    try {
      return [new URL(p.baseUrl).hostname.toLowerCase()];
    } catch {
      return [];
    }
  }),
]);

const PRIVATE_SUFFIXES = [".local", ".lan", ".internal", ".home.arpa"];

/** Classify the host of `url`; `undefined` when it does not parse. */
export function classifyTransportHost(
  url: string,
): TransportHostClass | undefined {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (hostname.length === 0) return undefined;
  // WHATWG URL keeps IPv6 brackets in `hostname`; drop a trailing dot.
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");

  if (isLoopback(host)) return "localhost";
  if (isPrivate(host)) return "private";
  if (KNOWN_CLOUD_HOSTS.has(host)) return "known_cloud";
  return "other";
}

function isLoopback(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  const v4 = parseIpv4(host);
  return v4 !== undefined && v4[0] === 127;
}

function isPrivate(host: string): boolean {
  const v4 = parseIpv4(host);
  if (v4 !== undefined) {
    const [a, b] = v4;
    return (
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (host.includes(":")) {
    // IPv6: unique-local fc00::/7 and link-local fe80::/10.
    return (
      /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
    );
  }
  if (!host.includes(".")) return true; // single-label name (`gpu-box`)
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function parseIpv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n <= 255) ? nums : undefined;
}
