/**
 * Small XML vocabulary shared by the PPTX part builders: escaping,
 * namespaces and slide geometry. PresentationML measures in EMU
 * (914 400 per inch); the deck is 16:9 at 13.333 × 7.5 in.
 */

export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** The three namespaces every slide-shaped part declares. */
export const PML_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

export const SLIDE_WIDTH = 12_192_000;
export const SLIDE_HEIGHT = 6_858_000;
export const NOTES_WIDTH = 6_858_000;
export const NOTES_HEIGHT = 9_144_000;
export const EMU_PER_INCH = 914_400;

/**
 * Escape text for an XML element or attribute, dropping the control
 * characters XML 1.0 forbids (a stray \u0007 from a scraped page would
 * otherwise make PowerPoint refuse the whole file as corrupt).
 */
export function escapeXml(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface Box {
  x: number;
  y: number;
  cx: number;
  cy: number;
}

export function xfrm(box: Box): string {
  const r = (n: number) => Math.round(n);
  return `<a:xfrm><a:off x="${r(box.x)}" y="${r(box.y)}"/><a:ext cx="${r(box.cx)}" cy="${r(box.cy)}"/></a:xfrm>`;
}

export function relationships(
  rels: readonly { id: string; type: string; target: string }[],
): string {
  return (
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    rels
      .map((rel) => {
        // Short names are officeDocument relationships; the package-level
        // core-properties one has its own base, so it is passed in full.
        const type = rel.type.startsWith("http") ? rel.type : `${REL}/${rel.type}`;
        return `<Relationship Id="${rel.id}" Type="${type}" Target="${escapeXml(rel.target)}"/>`;
      })
      .join("") +
    "</Relationships>"
  );
}
