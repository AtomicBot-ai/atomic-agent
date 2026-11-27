/**
 * ATO-2517: a deck's slides drawn by Microsoft PowerPoint on Windows, when it
 * is installed and LibreOffice is not (or LibreOffice failed). The decisions
 * only, with no process in them: slide-render.ts finds the programs and runs
 * the plan, and reads the PDF back as it reads LibreOffice's.
 *
 * PowerPoint is driven through its COM object from Windows PowerShell, the
 * way Office's own automation samples save a deck as PDF:
 * `Presentations.Open(file, ReadOnly, Untitled:=false, WithWindow:=false)`,
 * then `SaveAs(out, ppSaveAsPDF = 32)`. No window opens; the deck is opened
 * read-only and closed again; PowerPoint quits afterwards only when no other
 * presentation is open in it (the person's own work is never closed), and
 * its alert setting is put back as it was.
 *
 * The script goes in as `-EncodedCommand` (base64 of UTF-16LE text), so no
 * shell or command-line parser reads it. The two paths are PowerShell
 * single-quoted literals: nothing inside one is expanded, and a quote mark
 * (PowerShell counts the curly ones too) is written twice. A path with a
 * control character is not handed over at all.
 */

import { pathFor } from "./platform.js";
import type { SlideConverter } from "./slide-render-plan.js";

/** ppSaveAsPDF in PowerPoint's PpSaveAsFileType. */
export const PP_SAVE_AS_PDF = 32;
/** The name the PDF is saved under inside the converter's own temporary folder. */
export const POWERPOINT_PDF_NAME = "slides.pdf";

/** Where POWERPNT.EXE may be: Microsoft 365 / Office 2016 and later (Office16), then Office 2013 (Office15). */
export function powerPointCandidates(env: NodeJS.ProcessEnv): string[] {
  const P = pathFor("win32");
  const out: string[] = [];
  for (const root of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
    if (!root) continue;
    for (const sub of ["root\\Office16", "Office16", "root\\Office15", "Office15"]) {
      out.push(P.join(root, "Microsoft Office", sub, "POWERPNT.EXE"));
    }
  }
  return [...new Set(out)];
}

/** Windows PowerShell 5.1, which every supported Windows has in the same place. */
export function powerShellPath(env: NodeJS.ProcessEnv): string {
  const P = pathFor("win32");
  return P.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** `s` as a PowerShell single-quoted string, or null when it holds a control character. */
export function psLiteral(s: string): string | null {
  if (typeof s !== "string" || !s) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return "'" + s.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&") + "'";
}

/** The script that saves `file` as a PDF at `outFile`; null when a path cannot be written safely. */
export function powerPointScript(file: string, outFile: string): string | null {
  const src = psLiteral(file);
  const dst = psLiteral(outFile);
  if (!src || !dst) return null;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$app = New-Object -ComObject PowerPoint.Application",
    "$alerts = $app.DisplayAlerts",
    "$deck = $null",
    "try {",
    "  $app.DisplayAlerts = 1",
    `  $deck = $app.Presentations.Open(${src}, -1, 0, 0)`,
    `  $deck.SaveAs(${dst}, ${PP_SAVE_AS_PDF})`,
    "} finally {",
    "  if ($deck) { $deck.Close() }",
    "  $app.DisplayAlerts = $alerts",
    "  if ($app.Presentations.Count -eq 0) { $app.Quit() }",
    "}",
  ].join("\n");
}

/** PowerShell's `-EncodedCommand` form of a script: base64 of its UTF-16LE text. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** The plan that has PowerPoint save `file` as `outFile` (a PDF in the converter's own folder), or null. */
export function powerPointPlan(powershell: string, file: string, outFile: string): SlideConverter | null {
  const script = powerPointScript(file, outFile);
  if (!script) return null;
  return {
    kind: "powerpoint",
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    // PowerPoint's own cold start plus a long deck; the same bound as LibreOffice's.
    timeoutMs: 90_000,
  };
}
