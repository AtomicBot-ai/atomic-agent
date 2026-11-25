import { relationshipsXml, type Relationship } from "../ooxml/ooxml-package.js";

/**
 * Small XML vocabulary shared by the PPTX part builders: escaping,
 * namespaces and slide geometry. PresentationML measures in EMU
 * (914 400 per inch); the deck is 16:9 at 13.333 × 7.5 in.
 */

export const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export { NS_PKG_REL, REL, XML_HEAD, escapeXml } from "../ooxml/ooxml-package.js";

/** The three namespaces every slide-shaped part declares. */
export const PML_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

export const SLIDE_WIDTH = 12_192_000;
export const SLIDE_HEIGHT = 6_858_000;
export const NOTES_WIDTH = 6_858_000;
export const NOTES_HEIGHT = 9_144_000;
export const EMU_PER_INCH = 914_400;

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

/** A whole `.rels` part (the shared OOXML helper; kept under this name for the deck builders). */
export function relationships(rels: readonly Relationship[]): string {
  return relationshipsXml(rels);
}
