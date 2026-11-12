import type { PptxDeckSpec, PptxThemeName } from "./pptx-spec.js";
import { escapeXml } from "./pptx-xml.js";

/**
 * Colours and font one deck is drawn with. Slides take their colours
 * from here explicitly (background, title, body), and the same values go
 * into `theme1.xml` so a user who opens Design → Variants in PowerPoint
 * sees the deck's own palette rather than Office's default.
 */
export interface PptxPalette {
  background: string;
  title: string;
  text: string;
  accent: string;
  /** Subtitles and slide numbers. */
  muted: string;
  font: string;
}

const PRESETS: Record<PptxThemeName, Omit<PptxPalette, "font">> = {
  light: { background: "FFFFFF", title: "1F2937", text: "374151", accent: "2F6FEB", muted: "6B7280" },
  dark: { background: "111827", title: "F9FAFB", text: "E5E7EB", accent: "60A5FA", muted: "9CA3AF" },
  blue: { background: "0B3D91", title: "FFFFFF", text: "E0EAFF", accent: "FFC857", muted: "B9CCF5" },
  warm: { background: "FFF8F0", title: "3D2C29", text: "4A3B37", accent: "D9480F", muted: "8A7A74" },
};

const DEFAULT_FONT = "Calibri";

export function resolvePalette(spec: Pick<PptxDeckSpec, "theme" | "accentColor" | "font">): PptxPalette {
  const preset = PRESETS[spec.theme];
  return {
    ...preset,
    ...(spec.accentColor === undefined ? {} : { accent: spec.accentColor }),
    font: spec.font ?? DEFAULT_FONT,
  };
}

const srgb = (hex: string) => `<a:srgbClr val="${hex}"/>`;

/** A complete DrawingML theme: colour scheme, font scheme, format scheme. */
export function themeXml(palette: PptxPalette): string {
  const font = escapeXml(palette.font);
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Atomic">' +
    "<a:themeElements>" +
    '<a:clrScheme name="Atomic">' +
    `<a:dk1>${srgb("000000")}</a:dk1><a:lt1>${srgb("FFFFFF")}</a:lt1>` +
    `<a:dk2>${srgb(palette.title)}</a:dk2><a:lt2>${srgb(palette.background)}</a:lt2>` +
    `<a:accent1>${srgb(palette.accent)}</a:accent1><a:accent2>${srgb(palette.muted)}</a:accent2>` +
    `<a:accent3>${srgb("10B981")}</a:accent3><a:accent4>${srgb("F59E0B")}</a:accent4>` +
    `<a:accent5>${srgb("EF4444")}</a:accent5><a:accent6>${srgb("8B5CF6")}</a:accent6>` +
    `<a:hlink>${srgb(palette.accent)}</a:hlink><a:folHlink>${srgb(palette.muted)}</a:folHlink>` +
    "</a:clrScheme>" +
    '<a:fontScheme name="Atomic">' +
    `<a:majorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
    `<a:minorFont><a:latin typeface="${font}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
    "</a:fontScheme>" +
    '<a:fmtScheme name="Atomic">' +
    `<a:fillStyleLst>${fill}${fill}${fill}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst>" +
    "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3) +
    "</a:effectStyleLst>" +
    `<a:bgFillStyleLst>${fill}${fill}${fill}</a:bgFillStyleLst>` +
    "</a:fmtScheme>" +
    "</a:themeElements>" +
    "<a:objectDefaults/><a:extraClrSchemeLst/>" +
    "</a:theme>"
  );
}
