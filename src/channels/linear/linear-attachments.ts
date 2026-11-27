/**
 * Files attached to a Linear comment (ATO-2464).
 *
 * Linear stores an upload as a markdown link or image in the comment
 * body, pointing at `https://uploads.linear.app/...`. Those URLs need the
 * API key, so the channel downloads them itself and saves them to the
 * shared inbox (`<stateDir>/inbox/linear/...`), then appends the usual
 * attachments block so the agent reads them by path, the same as files
 * sent on Telegram or Discord.
 *
 * The key is only ever sent to `uploads.linear.app` over HTTPS; a
 * redirect is followed once, without the key. Any other link in the
 * comment is left as text.
 */

import {
  formatBytes,
  type AttachmentInbox,
  type AttachmentOutcome,
} from "../attachments/inbox.js";
import { linearAuthHeader } from "./linear-api.js";
import { scrubLinearError } from "./linear-types.js";

export const LINEAR_UPLOAD_HOST = "uploads.linear.app";
/** Largest file the channel downloads. */
export const LINEAR_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
/** Files taken from one comment; the rest are named as skipped. */
export const LINEAR_ATTACHMENTS_PER_COMMENT = 5;
const FETCH_TIMEOUT_MS = 60_000;

export interface LinearUpload {
  name: string;
  url: string;
}

/** Markdown `[name](url)` / `![name](url)` and bare upload URLs in `body`, in order, once each. */
export function findLinearUploads(body: string): LinearUpload[] {
  const out: LinearUpload[] = [];
  const seen = new Set<string>();
  const push = (name: string, url: string): void => {
    if (!isLinearUploadUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ name: name.trim() || basename(url), url });
  };
  const linked = /!?\[([^\]]*)\]\((https:\/\/[^)\s]+)\)/g;
  for (const m of body.matchAll(linked)) push(m[1] ?? "", m[2] ?? "");
  const bare = /(?<![(\w])https:\/\/uploads\.linear\.app\/[^\s)\]>"']+/g;
  for (const m of body.matchAll(bare)) push("", m[0]);
  return out;
}

export function isLinearUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === LINEAR_UPLOAD_HOST;
  } catch {
    return false;
  }
}

function basename(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter((p) => p.length > 0).pop();
    return last ? decodeURIComponent(last) : "attachment";
  } catch {
    return "attachment";
  }
}

export interface LinearDownload {
  bytes: Uint8Array;
  mimeType?: string;
}

/**
 * Download one upload with the API key. Throws on a host that is not
 * Linear's, a non-2xx answer, or a file over the limit.
 */
export async function downloadLinearUpload(
  rawUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LinearDownload> {
  if (!isLinearUploadUrl(rawUrl)) throw new Error("not a Linear upload URL");
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let res = await fetchImpl(rawUrl, {
    headers: { Authorization: linearAuthHeader(apiKey) },
    redirect: "manual",
    signal,
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    const next = location ? new URL(location, rawUrl) : null;
    if (next === null || next.protocol !== "https:") throw new Error("Linear sent a redirect that cannot be followed");
    // Storage URLs are pre-signed; the key never goes to another host.
    res = await fetchImpl(next.toString(), { redirect: "error", signal });
  }
  if (!res.ok) throw new Error(`Linear answered HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > LINEAR_ATTACHMENT_LIMIT_BYTES) throw new Error(tooBig());
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > LINEAR_ATTACHMENT_LIMIT_BYTES) throw new Error(tooBig());
  const type = res.headers.get("content-type")?.split(";")[0]?.trim();
  return { bytes, ...(type ? { mimeType: type } : {}) };
}

function tooBig(): string {
  return `over the ${formatBytes(LINEAR_ATTACHMENT_LIMIT_BYTES)} limit`;
}

export interface ReceiveLinearUploadsDeps {
  inbox: AttachmentInbox;
  download: (url: string) => Promise<LinearDownload>;
  logger: { warn: (msg: string, ctx?: Record<string, unknown>) => void };
}

/** Download and save each upload. Never rejects: a bad file is a `failed` outcome. */
export async function receiveLinearUploads(
  uploads: readonly LinearUpload[],
  deps: ReceiveLinearUploadsDeps,
): Promise<AttachmentOutcome[]> {
  const taken = uploads.slice(0, LINEAR_ATTACHMENTS_PER_COMMENT);
  const outcomes = await Promise.all(
    taken.map(async (upload): Promise<AttachmentOutcome> => {
      try {
        const file = await deps.download(upload.url);
        const saved = await deps.inbox.save({ name: upload.name, bytes: file.bytes, mimeType: file.mimeType });
        return { status: "saved", saved };
      } catch (err) {
        const reason = scrubLinearError(err);
        deps.logger.warn("linear: attachment not saved", { name: upload.name, error: reason });
        return { status: "failed", name: upload.name, reason };
      }
    }),
  );
  for (const skipped of uploads.slice(LINEAR_ATTACHMENTS_PER_COMMENT)) {
    outcomes.push({ status: "failed", name: skipped.name, reason: `only ${LINEAR_ATTACHMENTS_PER_COMMENT} files per comment are read` });
  }
  return outcomes;
}
