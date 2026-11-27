/**
 * ATO-2517: a deck's slides drawn by Microsoft PowerPoint on Windows, when it
 * is installed and LibreOffice is not (or LibreOffice failed). The decisions
 * only, with no process in them: slide-render.ts finds the programs and runs
 * the plan, and reads the PDF back as it reads LibreOffice's.
 *
 * PowerPoint is driven through its COM object from Windows PowerShell, the
 * way Office's own automation samples save a deck as PDF:
 * `Presentations.Open(file, ReadOnly, Untitled:=false, WithWindow:=false)`,
 * then `SaveAs(out, ppSaveAsPDF = 32)`. No window opens; a copy of the deck
 * is opened read-only and closed again; PowerPoint quits afterwards only when
 * this script started it and nothing else is open in it (a PowerPoint the
 * person already had running stays), and its alert and macro settings are
 * put back as they were. When the run fails or hits its time limit, a second
 * short script does that cleanup, and as a last resort ends the PowerPoint
 * the first one started (never one that was already running).
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
export const POWERPOINT_TIMEOUT_MS = 90_000;
/** The cleanup only closes one deck and quits; a PowerPoint that does not answer in this long is hung. */
export const POWERPOINT_CLEANUP_TIMEOUT_MS = 20_000;
export const POWERPOINT_KILL_TIMEOUT_MS = 10_000;

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

/**
 * Where one PowerPoint run works, all inside the converter's own temporary
 * folder but `deck`: the person's file, which is only copied (`copy` is what
 * PowerPoint opens, so their own open window of the same deck is never the
 * one closed), `pdf` the result, `state` what the cleanup needs to know.
 */
export type PowerPointPaths = { deck: string; copy: string; pdf: string; state: string };
export const POWERPOINT_COPY_NAME = "deck.pptx";
export const POWERPOINT_STATE_NAME = "powerpoint-state.txt";

function literals(p: PowerPointPaths): Record<keyof PowerPointPaths, string> | null {
  const out = { deck: psLiteral(p.deck), copy: psLiteral(p.copy), pdf: psLiteral(p.pdf), state: psLiteral(p.state) };
  return out.deck && out.copy && out.pdf && out.state ? (out as Record<keyof PowerPointPaths, string>) : null;
}

/** PowerPoint processes in this Windows session (another signed-in user's are not ours to count). */
const OURS = "Get-Process -Name POWERPNT -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }";

/**
 * The script that saves a copy of the deck as a PDF; null when a path cannot
 * be written safely. Before it starts PowerPoint it notes whether PowerPoint
 * was already running: only an instance this script started is ever quit
 * (New-Object attaches to the person's running PowerPoint, even one on its
 * start screen with no deck open). The state file holds, one per line:
 * was-running (1/0) and the time the script started (UTC ticks), written
 * before PowerPoint is asked for (so a PowerPoint that hangs while it starts
 * is still known to be ours), then also the alert and macro-security
 * settings to put back. Macros and add-in code stay off while the copy is
 * open (AutomationSecurity 3, msoAutomationSecurityForceDisable).
 */
export function powerPointScript(p: PowerPointPaths): string | null {
  const q = literals(p);
  if (!q) return null;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$t0 = [DateTime]::UtcNow.Ticks",
    `$wasRunning = @(${OURS}).Count -gt 0`,
    `Set-Content -LiteralPath ${q.state} -Encoding ASCII -Value @([int]$wasRunning, $t0)`,
    `Copy-Item -LiteralPath ${q.deck} -Destination ${q.copy}`,
    "$app = New-Object -ComObject PowerPoint.Application",
    "$alerts = $app.DisplayAlerts",
    "$security = $app.AutomationSecurity",
    `Set-Content -LiteralPath ${q.state} -Encoding ASCII -Value @([int]$wasRunning, $t0, [int]$alerts, [int]$security)`,
    "$deck = $null",
    "try {",
    "  $app.DisplayAlerts = 1",
    "  $app.AutomationSecurity = 3",
    `  $deck = $app.Presentations.Open(${q.copy}, -1, 0, 0)`,
    `  $deck.SaveAs(${q.pdf}, ${PP_SAVE_AS_PDF})`,
    "} finally {",
    "  if ($deck) { $deck.Close() }",
    "  $app.DisplayAlerts = $alerts",
    "  $app.AutomationSecurity = $security",
    "  if (-not $wasRunning -and $app.Presentations.Count -eq 0) { $app.Quit() }",
    "}",
  ].join("\n");
}

/**
 * The script run after a PowerPoint run failed or hit its time limit: Node's
 * timeout ends powershell.exe, so that script's `finally` never ran, but
 * POWERPNT.EXE is a COM server, not its child, and stays. This attaches to
 * the running PowerPoint without starting one, closes our copy if it is
 * still open (matched by its own folder, never the person's own decks), puts
 * the two settings back and quits only a PowerPoint the first script started
 * that has nothing else open. No state file: the first script never got as
 * far as PowerPoint, nothing to do.
 */
export function powerPointCleanupScript(p: PowerPointPaths): string | null {
  const q = literals(p);
  if (!q) return null;
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Test-Path -LiteralPath ${q.state})) { exit 0 }`,
    `$s = @(Get-Content -LiteralPath ${q.state})`,
    "if ($s.Count -lt 2) { exit 0 }",
    "try { $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { exit 0 }",
    // By file and folder name: a short (8.3) temp path from Node would not equal PowerPoint's FullName.
    `$name = Split-Path -Leaf ${q.copy}`,
    `$dir = Split-Path -Leaf (Split-Path -Parent ${q.copy})`,
    "foreach ($d in @($app.Presentations)) { if ($d.Name -eq $name -and (Split-Path -Leaf $d.Path) -eq $dir) { $d.Close() } }",
    "if ($s.Count -ge 4) { $app.DisplayAlerts = [int]$s[2]; $app.AutomationSecurity = [int]$s[3] }",
    "if ($s[0] -eq '0' -and $app.Presentations.Count -eq 0) { $app.Quit() }",
  ].join("\n");
}

export type PowerPointState = { wasRunning: boolean; since: string };

/** The state file's text as the cleanup reads it; null when it is not there or not whole. */
export function powerPointState(text: string | null): PowerPointState | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.length < 2 || !/^[01]$/.test(lines[0]) || !/^[1-9]\d{0,19}$/.test(lines[1])) return null;
  return { wasRunning: lines[0] === "1", since: lines[1] };
}

/**
 * The last resort when the cleanup itself did not finish (PowerPoint hung on
 * a dialog nobody can see, so every COM call blocks): end the PowerPoint the
 * first script started, and only that: a POWERPNT process in this session
 * that started after the script did, when none was running before it. Null
 * for a PowerPoint that was already running: the person's own is never ended.
 */
export function powerPointKillScript(state: PowerPointState | null): string | null {
  if (!state || state.wasRunning || !/^[1-9]\d{0,19}$/.test(state.since)) return null;
  return `${OURS} | Where-Object { try { $_.StartTime.ToUniversalTime().Ticks -ge ${state.since} } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue`;
}

/** PowerShell's `-EncodedCommand` form of a script: base64 of its UTF-16LE text. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function psPlan(powershell: string, script: string, timeoutMs: number): SlideConverter {
  return {
    kind: "powerpoint",
    command: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    timeoutMs,
  };
}

/** The plan that has PowerPoint save a copy of `paths.deck` as `paths.pdf`, or null. */
export function powerPointPlan(powershell: string, paths: PowerPointPaths): SlideConverter | null {
  const script = powerPointScript(paths);
  // PowerPoint's own cold start plus a long deck; the same bound as LibreOffice's.
  return script ? psPlan(powershell, script, POWERPOINT_TIMEOUT_MS) : null;
}

/** The cleanup's plan (well under the first run's bound), or null. */
export function powerPointCleanupPlan(powershell: string, paths: PowerPointPaths): SlideConverter | null {
  const script = powerPointCleanupScript(paths);
  return script ? psPlan(powershell, script, POWERPOINT_CLEANUP_TIMEOUT_MS) : null;
}

/** The kill's plan, or null when there is nothing of ours to end. */
export function powerPointKillPlan(powershell: string, state: PowerPointState | null): SlideConverter | null {
  const script = powerPointKillScript(state);
  return script ? psPlan(powershell, script, POWERPOINT_KILL_TIMEOUT_MS) : null;
}
