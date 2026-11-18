/**
 * Turn a fetched sitemap into XML text (ATO-970): `.xml.gz` files, sitemaps
 * sent as `application/gzip` / `application/x-gzip`, and ones sent with
 * `Content-Encoding: gzip` all arrive as gzip bytes (the crawl fetches
 * sitemaps with `binaryBody`, so curl does not unpack them) and are unpacked
 * here with Node's zlib.
 *
 * Gzip is recognised by its magic bytes, not by the file name or the
 * Content-Type: a `.gz` URL served already unpacked, and a gzip body under a
 * wrong type, both come out right. Two layers at most (a `.xml.gz` file sent
 * with `Content-Encoding: gzip` on top).
 *
 * The unpacked size is capped (`MAX_SITEMAP_XML_BYTES`, the sitemap
 * protocol's own 50 MB limit is far more than a 50-page crawl needs): a few
 * kilobytes of gzip can expand to gigabytes, and zlib stops at the cap
 * instead of allocating it. A body cut at the 2 MB download cap is unpacked
 * as far as it goes, so the `<loc>` entries before the cut still count.
 */
import { constants, gunzipSync } from "node:zlib";

/** Largest unpacked sitemap read. Past it the file is skipped as a possible gzip bomb. */
export const MAX_SITEMAP_XML_BYTES = 10 * 1024 * 1024;
const MAX_GZIP_LAYERS = 2;

export type SitemapText =
  | { ok: true; xml: string; gzipped: boolean }
  | { ok: false; reason: string };

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function decodeSitemapBody(
  input: { bytes?: Buffer; body: string },
  maxBytes: number = MAX_SITEMAP_XML_BYTES,
): SitemapText {
  let buf: Buffer = input.bytes ?? Buffer.from(input.body, "utf8");
  let layers = 0;
  while (isGzip(buf)) {
    if (layers >= MAX_GZIP_LAYERS) return { ok: false, reason: "gzipped more than twice; skipped" };
    try {
      buf = gunzipSync(buf, {
        maxOutputLength: maxBytes,
        // A body cut at the download cap ends mid-stream: keep what came out.
        finishFlush: constants.Z_SYNC_FLUSH,
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
        return {
          ok: false,
          reason: `larger than ${Math.round(maxBytes / 1024 / 1024)} MB once unzipped; skipped (possible gzip bomb)`,
        };
      }
      return { ok: false, reason: "not valid gzip; skipped" };
    }
    layers++;
  }
  if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
  return { ok: true, xml: buf.toString("utf8"), gzipped: layers > 0 };
}
