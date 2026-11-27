/**
 * The shared raw model (ATO-2336) forwards request bodies to the local
 * engine untouched. llama.cpp's server fetches an `http(s)` media URL in
 * a message itself when a projector is loaded, so a caller on the LAN
 * could make this computer fetch any address it can reach (an SSRF into
 * the operator's network). Media must come inline: a `data:` URL, or
 * base64 `input_audio.data`. Anything else is refused before forwarding.
 *
 * Precedent: OpenAI-compatible local servers that accept only base64
 * images (LM Studio's server), llama.cpp's own guidance to pass images
 * as data URLs.
 */
const URL_KEYS = new Set(["url", "image_url", "file_url", "audio_url", "input_audio"]);

/** Why `body` names remote media, or `null` when it does not. */
export function remoteMediaProblem(body: Buffer | undefined): string | null {
  if (!body || body.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null; // not JSON: the engine answers that with its own 400
  }
  const messages = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const found = firstRemoteUrl(part, 0);
      if (found) return `media must be sent inline as a data: URL, not ${JSON.stringify(found.slice(0, 80))}`;
    }
  }
  return null;
}

function firstRemoteUrl(value: unknown, depth: number): string | null {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (URL_KEYS.has(key) && typeof v === "string" && !v.trim().toLowerCase().startsWith("data:")) return v;
    if (typeof v === "object") {
      const inner = firstRemoteUrl(v, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}
