import { renderPixelText } from "./pixel-font.js";

/**
 * The frame every Atomic Agent mail is drawn in: a CRT bezel, a
 * transmission header, a pixel-font banner flanked by two invaders,
 * a readout panel, a footer that says who is speaking.
 *
 * Inbox constraints shape everything here. Gmail and Outlook strip
 * `<style>`, `@font-face`, `position`, most pseudo-elements and every
 * script, so the mail is tables with inline styles, one monospace
 * stack with a real fallback, and lettering made of characters. A
 * `background-image` scanline is layered over a solid
 * `background-color`, so a client that drops the image still shows the
 * screen. Nothing here depends on an external asset.
 */

/** The screen. Single-theme on purpose: it is a CRT wherever it lands. */
export const SCREEN = {
  bg: "#05070d",
  bezel: "#1f2a44",
  green: "#39ff14",
  cyan: "#7df9ff",
  amber: "#ffb000",
  muted: "#6b7a99",
  panel: "#0b1020",
  red: "#ff4f6d",
} as const;

export const MONO = "'Courier New', Courier, 'Lucida Console', monospace";

/** Our own 11×8 sprite — not an arcade one. Two frames for the two sides. */
const INVADER: readonly string[] = [
  "..X.....X..",
  "...X...X...",
  "..XXXXXXX..",
  ".XX.XXX.XX.",
  "XXXXXXXXXXX",
  "X.XXXXXXX.X",
  "X.X.....X.X",
  "...XX.XX...",
];

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A sprite as a table of 6px cells — the one pixel art every inbox can draw. */
export function renderSprite(color: string, mirror = false): string {
  const rows = INVADER.map((row) =>
    mirror ? [...row].reverse().join("") : row,
  );
  const cells = rows
    .map(
      (row) =>
        `<tr>${[...row]
          .map(
            (px) =>
              `<td width="6" height="6" style="width:6px;height:6px;line-height:6px;mso-line-height-rule:exactly;font-size:1px;padding:0;background:${px === "X" ? color : "transparent"}">&nbsp;</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 auto">${cells}</table>`;
}

/** The pixel-font banner, in a `<pre>` so the block glyphs keep their grid. */
export function renderBanner(text: string, color: string): string {
  const rows = renderPixelText(text);
  return `<pre style="margin:0;font-family:${MONO};font-size:13px;line-height:13px;letter-spacing:0;color:${color};text-align:center;white-space:pre">${esc(rows.join("\n"))}</pre>`;
}

/** `[██████████░░░░░] 64%` in a colour that says how it went. */
export function renderBar(percent: number, color: string, width = 24): string {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((p / 100) * width);
  return `<span style="color:${color}">[${"█".repeat(filled)}${"░".repeat(width - filled)}]</span> <span style="color:${SCREEN.cyan}">${p}%</span>`;
}

export interface MailShellInput {
  /** Small header line, e.g. `TRANSMISSION 0x1A`. */
  transmission: string;
  banner: string;
  bannerColor: string;
  /** Rows of the readout panel — already-escaped HTML fragments. */
  readout: string[];
  /** Amber status line under the readout, e.g. `ADDITIONAL WEIGHTS ACQUIRED`. */
  status: string;
  statusColor?: string;
  /** Call to action line, plain text. */
  cta: string;
  /** The agent's own address, shown in the footer. */
  from: string;
  /** The `<title>` / preheader. */
  title: string;
}

export function renderMailShell(input: MailShellInput): string {
  const readout = input.readout
    .map(
      (row) =>
        `<tr><td style="padding:2px 0;font-family:${MONO};font-size:15px;line-height:22px;color:${SCREEN.cyan}">${row}</td></tr>`,
    )
    .join("");
  const statusColor = input.statusColor ?? SCREEN.amber;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${esc(input.title)}</title>
</head>
<body style="margin:0;padding:24px 12px;background:${SCREEN.bg};background-color:${SCREEN.bg}">
<div style="display:none;max-height:0;overflow:hidden;color:${SCREEN.bg}">${esc(input.title)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" width="600" style="width:600px;max-width:100%;margin:0 auto;border-collapse:collapse">
  <tr><td style="padding:0;border:3px solid ${SCREEN.bezel};background:${SCREEN.bg};background-color:${SCREEN.bg};background-image:repeating-linear-gradient(0deg,rgba(255,255,255,0.025) 0 1px,transparent 1px 3px)">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
      <tr>
        <td style="padding:14px 20px 8px;font-family:${MONO};font-size:12px;letter-spacing:2px;color:${SCREEN.muted}">ATOMIC AGENT&nbsp;&nbsp;▮&nbsp;&nbsp;${esc(input.transmission)}</td>
      </tr>
      <tr>
        <td style="padding:6px 20px 10px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            <tr>
              <td width="72" style="width:72px;vertical-align:middle;padding:0">${renderSprite(input.bannerColor)}</td>
              <td style="vertical-align:middle;padding:0 6px">${renderBanner(input.banner, input.bannerColor)}</td>
              <td width="72" style="width:72px;vertical-align:middle;padding:0">${renderSprite(input.bannerColor, true)}</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 20px 4px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:${SCREEN.panel};border:1px solid ${SCREEN.bezel}">
            <tr><td style="padding:14px 18px">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">${readout}</table>
            </td></tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:12px 20px 4px;font-family:${MONO};font-size:13px;letter-spacing:2px;color:${statusColor};text-align:center">${esc(input.status)}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px 8px;font-family:${MONO};font-size:15px;color:${SCREEN.green};text-align:center">▶&nbsp; ${esc(input.cta)}</td>
      </tr>
      <tr>
        <td style="padding:10px 20px 16px;font-family:${MONO};font-size:11px;line-height:16px;color:${SCREEN.muted};text-align:center;border-top:1px solid ${SCREEN.bezel}">sent by ${esc(input.from)} · reply to talk to your agent</td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
