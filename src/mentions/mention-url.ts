/**
 * ATO-2241, shared since ATO-2472: `@https://...`, the page read as text (Cursor's @Web / @Link).
 * http(s) only, a time limit over the whole read, and a byte cap: the body
 * is read in chunks and the read is cancelled past the cap. Only text
 * answers are used (HTML is reduced to its words); anything else is named,
 * not inlined. A public link that redirects to this computer or the local
 * network is refused (mention-hosts.ts); a local link typed as such is read.
 * HTML is cut down by mention-html.ts in linear time. Offline mode
 * (`network.offline`) is checked before the request; the process-wide
 * dispatcher would refuse it anyway, this only says so plainly.
 */

import { findOfflineNetworkError, offlineRefusal } from "../llm/offline-network.js";
import { isLocalHost } from "./mention-hosts.js";
import { htmlToText } from "./mention-html.js";

export const URL_TIMEOUT_MS = 8_000;
/** Most raw bytes read from one page (HTML markup is cut down after). */
export const URL_MAX_RAW_BYTES = 512 * 1024;

export interface FetchedPage {
  text: string;
  /** The body was longer than URL_MAX_RAW_BYTES. */
  cut: boolean;
}

export type FetchUrl = (url: string) => Promise<FetchedPage>;

/** Raised for an answer that is read but not used: the reason goes in the block. */
export class UrlSkip extends Error {}

const TEXT_TYPE = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|ld\+json)|[^;]*\+(json|xml))/i;

export function createFetchUrl(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = URL_TIMEOUT_MS,
  maxBytes: number = URL_MAX_RAW_BYTES,
): FetchUrl {
  return async (url) => {
    const protocol = new URL(url).protocol;
    if (protocol !== "http:" && protocol !== "https:") throw new UrlSkip("only http and https links are read");
    if (offlineRefusal(url, "@link") !== null) throw new UrlSkip("offline mode is on");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, redirect: "follow", headers: { accept: "text/html, text/plain, */*;q=0.5" } });
      const final = res.url || url;
      if (!/^https?:/i.test(final)) throw new UrlSkip("redirected away from http");
      // A typed local host is on purpose; a public link landing on one is not.
      if (!isLocalHost(new URL(url).hostname) && isLocalHost(new URL(final).hostname)) {
        await res.body?.cancel().catch(() => undefined);
        throw new UrlSkip("redirected to a local address");
      }
      if (!res.ok) throw new UrlSkip(res.status === 404 ? "page not found" : "the site refused the request");
      const type = res.headers.get("content-type") ?? "text/plain";
      if (!TEXT_TYPE.test(type.trim())) throw new UrlSkip(`not a text page (${type.split(";")[0]})`);
      const { bytes, cut } = await readCapped(res, maxBytes);
      const raw = new TextDecoder("utf-8").decode(bytes);
      return { text: /html/i.test(type) ? htmlToText(raw) : raw, cut };
    } catch (err) {
      if (err instanceof UrlSkip) throw err;
      if (findOfflineNetworkError(err) !== null) throw new UrlSkip("offline mode is on");
      if (controller.signal.aborted) throw new UrlSkip(`no answer in ${Math.round(timeoutMs / 1000)} s`);
      throw new UrlSkip("could not be fetched");
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Uint8Array; cut: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.length >= room) {
      chunks.push(value.subarray(0, room));
      total += room;
      cut = value.length > room;
      if (!cut) {
        const next = await reader.read();
        cut = !next.done;
      }
      if (cut) await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { bytes: out, cut };
}
