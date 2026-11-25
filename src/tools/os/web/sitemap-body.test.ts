import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeSitemapBody, isGzip } from "./sitemap-body.js";

const XML = "<urlset><url><loc>https://example.com/a</loc></url></urlset>";

describe("decodeSitemapBody", () => {
  it("passes plain XML through, as text or as bytes", () => {
    expect(decodeSitemapBody({ body: XML })).toEqual({ ok: true, xml: XML, gzipped: false });
    expect(decodeSitemapBody({ bytes: Buffer.from(XML), body: "" })).toEqual({ ok: true, xml: XML, gzipped: false });
  });

  it("unzips gzip by its magic bytes, whatever the name or type said", () => {
    const gz = gzipSync(XML);
    expect(isGzip(gz)).toBe(true);
    expect(decodeSitemapBody({ bytes: gz, body: "" })).toEqual({ ok: true, xml: XML, gzipped: true });
  });

  it("unzips two layers (a .xml.gz sent with Content-Encoding: gzip) but not three", () => {
    expect(decodeSitemapBody({ bytes: gzipSync(gzipSync(XML)), body: "" })).toMatchObject({ ok: true, xml: XML });
    expect(decodeSitemapBody({ bytes: gzipSync(gzipSync(gzipSync(XML))), body: "" })).toMatchObject({ ok: false });
  });

  it("stops at the size cap instead of inflating a gzip bomb", () => {
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 0x20));
    const out = decodeSitemapBody({ bytes: bomb, body: "" }, 1024 * 1024);
    expect(out.ok).toBe(false);
    expect(out.ok ? "" : out.reason).toContain("gzip bomb");
  });

  it("keeps the entries before the cut of a body truncated at the download cap", () => {
    const many = `<urlset>${Array.from({ length: 4000 }, (_, i) => `<url><loc>https://example.com/p${i}</loc></url>`).join("")}</urlset>`;
    const gz = gzipSync(many);
    const out = decodeSitemapBody({ bytes: gz.subarray(0, Math.floor(gz.length / 2)), body: "" });
    expect(out.ok).toBe(true);
    expect(out.ok ? out.xml : "").toContain("<loc>https://example.com/p0</loc>");
  });

  it("reports a body that only looks like gzip", () => {
    const out = decodeSitemapBody({ bytes: Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]), body: "" });
    expect(out.ok).toBe(false);
  });
});
