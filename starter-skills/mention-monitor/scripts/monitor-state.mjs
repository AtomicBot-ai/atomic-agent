// Shared helpers for the mention-monitor scripts: where state lives, how
// it is read and written, and the polite HTTP GET both scripts use.
// State never lives in the skill folder itself, because starter skills
// are replaced on every boot.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const USER_AGENT =
  "atomic-agent-mention-monitor/1.0 (read-only mention digest; +https://atomicagent.io)";

/** `--state-dir`, else `<ATOMIC_AGENT_STATE_DIR>/mention-monitor`, else `~/.atomic-agent/mention-monitor`. */
export function resolveStateDir(explicit, env = process.env) {
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const base =
    typeof env.ATOMIC_AGENT_STATE_DIR === "string" && env.ATOMIC_AGENT_STATE_DIR.length > 0
      ? env.ATOMIC_AGENT_STATE_DIR
      : join(homedir(), ".atomic-agent");
  return join(base, "mention-monitor");
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write through a temp file so a killed run never leaves half a file. */
export function writeJson(path, value, dir) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/**
 * Minimal argv parser: `--flag value`, repeatable flags collect into
 * arrays, `--flag` with no value (or followed by another flag) is `true`.
 */
export function parseArgs(argv, repeatable = []) {
  const out = {};
  for (const name of repeatable) out[name] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const name = raw.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) i += 1;
    if (repeatable.includes(name)) {
      if (value !== true) out[name].push(value);
    } else {
      out[name] = value;
    }
  }
  return out;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET with a descriptive User-Agent and a timeout. A 429 waits once when
 * the server asks for at most 10 s, then gives up softly: the caller gets
 * `{ ok: false, status, reason }` instead of an exception.
 */
export async function politeGet(url, { fetchImpl = fetch, accept = "application/json", retry = true } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { ok: false, status: 0, reason: `network: ${err?.message ?? String(err)}` };
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after"));
    if (retry && Number.isFinite(wait) && wait >= 0 && wait <= 10) {
      await sleep(wait * 1000);
      return politeGet(url, { fetchImpl, accept, retry: false });
    }
    return { ok: false, status: 429, reason: "rate_limited" };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, reason: res.status === 403 ? "blocked" : `http_${res.status}` };
  }
  return { ok: true, status: res.status, text: await res.text() };
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function snippet(text, max = 280) {
  const flat = String(text ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
