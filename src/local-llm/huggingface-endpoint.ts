/**
 * Which host serves Hugging Face for this install. Catalogue entries,
 * custom models and download sidecars all keep canonical
 * `https://huggingface.co/...` URLs; the endpoint is applied at request
 * time only, so switching to a mirror (or back) never invalidates a
 * partial download or a stored model definition.
 *
 * `HF_ENDPOINT` is the variable `huggingface_hub` itself honours, so an
 * operator who already points Python tooling at a mirror gets the same
 * behaviour here without learning a second knob.
 */
export const DEFAULT_HF_ENDPOINT = "https://huggingface.co";

const CANONICAL_HOSTS = ["https://huggingface.co", "https://hf.co", "https://www.huggingface.co"];

let configuredEndpoint = DEFAULT_HF_ENDPOINT;

/** Origin form: scheme + host [+ port], no path, no trailing slash. */
export function normalizeHuggingFaceEndpoint(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Push-in from config load (`localModels.download.hfEndpoint`). */
export function setDefaultHuggingFaceEndpoint(endpoint: string): void {
  configuredEndpoint = normalizeHuggingFaceEndpoint(endpoint) ?? DEFAULT_HF_ENDPOINT;
}

/** `HF_ENDPOINT` env var first, then the configured value. */
export function resolveHuggingFaceEndpoint(): string {
  const env = process.env.HF_ENDPOINT;
  if (env) {
    const normalized = normalizeHuggingFaceEndpoint(env);
    if (normalized) return normalized;
  }
  return configuredEndpoint;
}

/** Whether `url` names Hugging Face — canonically or via the active endpoint. */
export function isHuggingFaceUrl(url: string): boolean {
  const endpoint = resolveHuggingFaceEndpoint();
  return CANONICAL_HOSTS.some((h) => url.startsWith(`${h}/`)) || url.startsWith(`${endpoint}/`);
}

/**
 * The URL to actually request for a canonical Hugging Face URL. Anything
 * that is not a canonical HF URL — a GitHub release asset, a mirror URL
 * the operator typed themselves — passes through untouched.
 */
export function rewriteHuggingFaceUrl(url: string): string {
  const endpoint = resolveHuggingFaceEndpoint();
  if (endpoint === DEFAULT_HF_ENDPOINT) return url;
  for (const host of CANONICAL_HOSTS) {
    if (url.startsWith(`${host}/`)) return `${endpoint}${url.slice(host.length)}`;
  }
  return url;
}

/** Host shown in messages ("Could not reach hf-mirror.com"). */
export function huggingFaceEndpointHost(): string {
  try {
    return new URL(resolveHuggingFaceEndpoint()).host;
  } catch {
    return "huggingface.co";
  }
}
