/**
 * ATO-2410: which program draws a .pptx deck's slides for the preview panel,
 * and how its output is made safe to show. The decisions, with no file system
 * or process in them (slide-render.ts runs them).
 *
 * office-preview.ts pulls only the text out of a deck; the panel drew it as
 * numbered cards, so a slide with a chart showed almost nothing. The slides
 * are drawn by a program the machine already has, as Finder's Quick Look and
 * the file managers on Linux do, never by code the app ships:
 *
 * - LibreOffice, when it is installed (`soffice --headless --convert-to pdf`,
 *   the command Nextcloud, Paperless and unoconv use): the whole deck as one
 *   PDF, every slide a page with its layout, pictures, tables and charts. The
 *   panel shows it with Chromium's own PDF viewer, as it shows a .pdf file.
 *   Preferred everywhere it exists: it is the one that draws charts.
 * - Quick Look on macOS (`qlmanage -p -o dir`, the Office generator Finder
 *   uses): one HTML page of every slide, laid out with its colours, text and
 *   tables; pictures come as files beside it and are inlined here as `data:`
 *   URLs. Charts are left out (checked 27.11.2026 on a 3-slide deck). Shown
 *   in the same sandboxed frame as an .html file: no script, no network.
 * - PowerPoint on Windows (ATO-2517, slide-render-powerpoint.ts): its own
 *   "Save as PDF" through COM, when LibreOffice is missing or fails. Draws
 *   charts too.
 * - None of them (Linux without LibreOffice, Windows without either): the
 *   text cards stay, as before. No converter is bundled with the app: no
 *   maintained JavaScript renderer draws a deck's charts and layouts
 *   faithfully, and a half-drawn slide would read as the real one.
 *
 * Every output is capped (the PDF, the HTML, the pictures) so a crafted deck
 * cannot fill memory through the converter; over a cap, the cards stay.
 */

import { isRelsName, relsLinksOut } from "./deck-rels.js";
import { pathFor, type Platform } from "./platform.js";

export const SLIDES_PDF_MAX_BYTES = 32 * 1024 * 1024;     // file-preview.ts's own PDF cap
export const SLIDES_HTML_MAX_BYTES = 8 * 1024 * 1024;
export const SLIDES_IMAGE_MAX_BYTES = 15 * 1024 * 1024;   // one picture, image-data-url.ts's cap
export const SLIDES_IMAGES_TOTAL_MAX_BYTES = 24 * 1024 * 1024;
/** Quick Look's page is laid out for this many CSS pixels (its PreviewProperties.plist Width) when the plist says nothing. */
export const QUICKLOOK_DEFAULT_WIDTH = 753;
/** office-preview.ts's OFFICE_LIMITS.entries: a directory this long may hide parts openZip never read. */
export const DECK_ENTRIES_CAP = 5000;

/** ATO-2517 added "powerpoint": PowerPoint on Windows saving a PDF (slide-render-powerpoint.ts). */
export type SlideConverterKind = "soffice" | "quicklook" | "powerpoint";
export type SlideConverter = { kind: SlideConverterKind; command: string; args: string[]; timeoutMs: number };

/** Where LibreOffice's launcher may be, most likely first; `env.PATH` entries after the fixed places. */
export function sofficeCandidates(platform: Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const P = pathFor(platform);
  const out: string[] = [];
  const names: string[] = [];
  if (platform === "darwin") {
    out.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    if (home) out.push(P.join(home, "Applications", "LibreOffice.app", "Contents", "MacOS", "soffice"));
    names.push("soffice");
  } else if (platform === "win32") {
    // soffice.com is the console launcher: it waits for the conversion and relays its output; soffice.exe may return first.
    for (const root of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA ? P.join(env.LOCALAPPDATA, "Programs") : ""]) {
      if (root) out.push(P.join(root, "LibreOffice", "program", "soffice.com"), P.join(root, "LibreOffice", "program", "soffice.exe"));
    }
    names.push("soffice.com", "soffice.exe");
  } else {
    out.push("/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/lib/libreoffice/program/soffice",
      "/usr/lib64/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice");
    names.push("soffice", "libreoffice");
  }
  const sep = platform === "win32" ? ";" : ":";
  for (const dir of String(env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const n of names) out.push(P.join(dir, n));
  }
  return [...new Set(out)];
}

/** The first candidate that exists, or null. */
export function findSoffice(candidates: readonly string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) {
    try { if (exists(c)) return c; } catch { /* unreadable: not it */ }
  }
  return null;
}

export const QLMANAGE = "/usr/bin/qlmanage";

/** Whether this machine has a program that can draw the slides at all (`powerpoint`: PowerShell and PowerPoint both found, ATO-2517). */
export function slidesRenderableWith(platform: Platform, soffice: string | null, exists: (p: string) => boolean, powerpoint = false): boolean {
  if (soffice || (platform === "win32" && powerpoint)) return true;
  if (platform !== "darwin") return false;
  try { return exists(QLMANAGE); } catch { return false; }
}

/**
 * Whether a deck points outside its own file: any relationship part
 * (`*.rels`) with a TargetMode other than Internal or an absolute Target, the
 * way a linked picture, video, OLE object or hyperlink is written. LibreOffice
 * and PowerPoint may fetch a linked part while they draw, so such a deck is
 * handed to neither. Each part is read as XML in its own encoding
 * (deck-rels.ts, ATO-2517), not matched as UTF-8 text. Fails closed: no
 * archive, a `.rels` that cannot be read within the caps or parsed, a
 * directory that hit openZip's entry cap (entries past it are never looked
 * at) or a name that appears twice (only the first copy is read) counts as
 * linking out. `zip` is office-preview.ts's `openZip` result.
 */
export function deckLinksOut(
  zip: { entries: ReadonlyMap<string, unknown>; duplicates?: boolean; bytes?: (name: string) => Buffer | null; read: (name: string) => string | null } | null,
  maxEntries = DECK_ENTRIES_CAP,
): boolean {
  if (!zip || zip.duplicates === true || zip.entries.size >= maxEntries) return true;
  for (const name of zip.entries.keys()) {
    if (!isRelsName(name)) continue;
    let raw: Buffer | null;
    if (zip.bytes) raw = zip.bytes(name);
    else { const text = zip.read(name); raw = text === null ? null : Buffer.from(text, "utf8"); }
    if (raw === null || relsLinksOut(raw)) return true;
  }
  return false;
}

/**
 * The converters to try for `file`, in order, each writing into `outDir`.
 * `profileUrl` is a `file:` URL of a folder LibreOffice may use as its own
 * profile: a running LibreOffice would otherwise take the request over (and
 * a second conversion would fail on its lock). Arguments only, no shell.
 */
export function converterPlans(
  platform: Platform,
  file: string,
  outDir: string,
  profileUrl: string,
  soffice: string | null,
  qlmanage = QLMANAGE,
): SlideConverter[] {
  const plans: SlideConverter[] = [];
  if (soffice) {
    plans.push({
      kind: "soffice",
      command: soffice,
      args: ["--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
        "-env:UserInstallation=" + profileUrl, "--convert-to", "pdf", "--outdir", outDir, file],
      // A cold start makes its profile first: 12 s seen on an M-series Mac; slow disks take longer.
      timeoutMs: 90_000,
    });
  }
  if (platform === "darwin") plans.push({ kind: "quicklook", command: qlmanage, args: ["-p", "-o", outDir, file], timeoutMs: 20_000 });
  return plans;
}

/** Among `names` (one output folder's entries), the converter's result: the `.qlpreview` folder for Quick Look, else the first `.pdf`. */
export function pickOutput(kind: SlideConverterKind, names: readonly string[]): string | null {
  const want = kind === "quicklook" ? /\.qlpreview$/i : /\.pdf$/i;
  return names.find((n) => want.test(n)) ?? null;
}

/** Quick Look names a slide's picture `Attachment<n>.<ext>` beside Preview.html; nothing else in that folder is read. */
export function isAttachmentName(name: string): boolean {
  return /^Attachment\d{1,6}\.[A-Za-z0-9]{1,5}$/.test(name);
}

/**
 * Quick Look's HTML with each `src="Attachment1.png"` pointing at the picture
 * itself, inlined as a `data:` URL, so the sandboxed frame (which may load
 * only `data:` images) shows it. A name not in `pictures` (over a cap, not a
 * picture by its bytes) is left as it is and draws nothing. Linear: one pass
 * over the attributes, no backtracking across them.
 */
export function inlineAttachments(html: string, pictures: ReadonlyMap<string, string>): string {
  if (!pictures.size) return html;
  return html.replace(/\ssrc=(["'])([^"'<>]{1,64})\1/g, (whole, _q: string, name: string) => {
    const url = pictures.get(name);
    return url ? ` src="${url}"` : whole;
  });
}

/** The width Quick Look laid its page out for (PreviewProperties.plist's top-level Width), within reason. */
export function quickLookWidth(plist: string): number {
  const m = /<key>Width<\/key>\s*<real>([0-9.]+)<\/real>/.exec(plist);
  const w = m ? Number(m[1]) : NaN;
  return w >= 200 && w <= 4000 ? Math.round(w) : QUICKLOOK_DEFAULT_WIDTH;
}

/** Whether a deck has a chart part (`ppt/charts/chartN.xml`): Quick Look leaves those out of its page (ATO-2517). */
export function deckHasCharts(zip: { entries: ReadonlyMap<string, unknown> } | null): boolean {
  if (!zip) return false;
  for (const name of zip.entries.keys()) if (/^ppt\/charts\/chart\d+\.xml$/i.test(name)) return true;
  return false;
}

/**
 * The slides as the panel gets them: a PDF's bytes, or Quick Look's page and
 * the width it was drawn for; `charts` when the deck has charts that page
 * leaves out, so the panel can say so (ATO-2517).
 */
export type SlideRender =
  | { kind: "pdf"; base64: string }
  | { kind: "html"; html: string; width: number; charts?: boolean };
