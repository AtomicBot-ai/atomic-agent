/**
 * A copy or a paste in the app in front, through the system clipboard.
 *
 * Two features need it: the quick-entry box reading the text selected in
 * another app (ATO-985), and dictation typed into any app (ATO-1064). Both
 * do what Raycast, PopClip and Superwhisper do: keep what was on the
 * clipboard, press ⌘C / ⌘V (Ctrl+C / Ctrl+V) in the app in front, then put
 * the old clipboard back, so the user's own copy is not lost.
 *
 * This module is the pure half: which command presses the keys on each
 * platform, and the order of the clipboard steps behind an injected host,
 * so test/keystroke-clipboard.test.mjs runs it without Electron.
 * keystroke-clipboard-host.ts is the Electron half.
 */

export type KeystrokeKind = "copy" | "paste";

export interface KeystrokeCommand {
  file: string;
  args: string[];
}

export interface KeystrokeEnv {
  platform: NodeJS.Platform | string;
  env: Record<string, string | undefined>;
}

function isWayland(env: Record<string, string | undefined>): boolean {
  return !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland";
}

/**
 * Windows programs whose window is a console or a terminal. There Ctrl+C with
 * nothing selected is not a copy but an interrupt: it would stop the build,
 * server or script running in it. A copy is never pressed into them, so the
 * quick-entry box simply gets no selection. Lower case, without ".exe".
 * A paste (Ctrl+V) interrupts nothing, so dictation still types into them.
 * macOS is left alone: ⌘C in Terminal or iTerm only copies.
 */
export const WINDOWS_CONSOLE_PROCESSES: readonly string[] = [
  "cmd", "powershell", "pwsh", "powershell_ise", "conhost", "openconsole",
  "windowsterminal", "wt", "mintty", "bash", "wsl", "alacritty", "wezterm", "wezterm-gui",
];

/** True when the process in front is a console or terminal (see WINDOWS_CONSOLE_PROCESSES). */
export function isWindowsConsoleProcess(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.trim().toLowerCase().replace(/\.exe$/, "");
  return WINDOWS_CONSOLE_PROCESSES.includes(n);
}

/** Exit code of the Windows copy when it skipped a console in front. */
export const WIN_CONSOLE_SKIP_EXIT = 3;

/**
 * The PowerShell that runs before the Windows copy: the process of the
 * window in front, and an exit with WIN_CONSOLE_SKIP_EXIT (no key pressed)
 * when it is a console. Single quotes only, so it survives the command line.
 */
const WIN_CONSOLE_GUARD = [
  "Add-Type -Namespace AtomicAgent -Name Fg -MemberDefinition '[DllImport(''user32.dll'')] public static extern System.IntPtr GetForegroundWindow(); [DllImport(''user32.dll'')] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);';",
  "$fgPid = [uint32]0; [void][AtomicAgent.Fg]::GetWindowThreadProcessId([AtomicAgent.Fg]::GetForegroundWindow(), [ref]$fgPid);",
  "$fgName = ''; try { $fgName = (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName.ToLower() } catch {}",
  `if (@(${WINDOWS_CONSOLE_PROCESSES.map((n) => `'${n}'`).join(",")}) -contains $fgName) { exit ${WIN_CONSOLE_SKIP_EXIT} };`,
].join(" ");

/**
 * The commands that press ⌘C/⌘V (Ctrl elsewhere) in the app in front, in the
 * order to try them; empty where nothing can. On Linux the tool may not be
 * installed, so the host tries the next one when a file is missing.
 */
export function keystrokeCommands(kind: KeystrokeKind, o: KeystrokeEnv): KeystrokeCommand[] {
  const letter = kind === "copy" ? "c" : "v";
  if (o.platform === "darwin") {
    return [{ file: "/usr/bin/osascript", args: ["-e", `tell application "System Events" to keystroke "${letter}" using command down`] }];
  }
  if (o.platform === "win32") {
    const send = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^${letter}')`;
    return [{
      file: "powershell.exe",
      args: [
        "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
        kind === "copy" ? `${WIN_CONSOLE_GUARD} ${send}` : send,
      ],
    }];
  }
  if (o.platform === "linux") {
    const x11: KeystrokeCommand = { file: "xdotool", args: ["key", "--clearmodifiers", `ctrl+${letter}`] };
    if (isWayland(o.env)) return [{ file: "wtype", args: ["-M", "ctrl", letter, "-m", "ctrl"] }, ...(o.env.DISPLAY ? [x11] : [])];
    return o.env.DISPLAY ? [x11] : [];
  }
  return [];
}

/**
 * Linux keeps the selected text apart from the clipboard (the PRIMARY
 * selection), so it is read straight, with no key press and no clipboard
 * touched. Empty off Linux.
 */
export function primarySelectionCommands(o: KeystrokeEnv): KeystrokeCommand[] {
  if (o.platform !== "linux") return [];
  const x11: KeystrokeCommand[] = [
    { file: "xclip", args: ["-o", "-selection", "primary"] },
    { file: "xsel", args: ["--output", "--primary"] },
  ];
  if (isWayland(o.env)) return [{ file: "wl-paste", args: ["--primary", "--no-newline"] }, ...(o.env.DISPLAY ? x11 : [])];
  return o.env.DISPLAY ? x11 : [];
}

/* ---------------- the clipboard steps ---------------- */

/** The clipboard, as much of it as the steps need. `S` is what save() keeps. */
export interface ClipboardHost<S> {
  save(): S;
  restore(saved: S): void;
  readText(): string;
  writeText(text: string): void;
  clear(): void;
}

export interface KeystrokeDeps {
  /** Presses the keys; false when no command could run. */
  press: (kind: KeystrokeKind) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/** The longest selection the box takes: a page or two of text. */
export const SELECTION_MAX_CHARS = 8000;

export interface GrabOptions {
  /** Wait before the key press: the hotkey's own modifiers are still held. */
  settleMs?: number;
  /** How long the app in front gets to put the copy on the clipboard. */
  timeoutMs?: number;
  pollMs?: number;
}

/** A copied text as the box shows it: trimmed, capped, null for nothing. */
export function cleanSelection(raw: unknown, max = SELECTION_MAX_CHARS): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The selected text of the app in front, by a copy: the clipboard is kept,
 * emptied, ⌘C pressed, read until the copy lands (or the time runs out:
 * nothing was selected), and put back as it was, whatever happened.
 * Never throws; null when nothing was selected or the keys could not be pressed.
 */
export async function grabSelectionByCopy<S>(host: ClipboardHost<S>, deps: KeystrokeDeps, opts: GrabOptions = {}): Promise<string | null> {
  const settle = opts.settleMs ?? 120;
  const timeout = opts.timeoutMs ?? 450;
  const poll = opts.pollMs ?? 30;
  let saved: S;
  try {
    saved = host.save();
  } catch {
    return null;
  }
  try {
    host.clear();
    if (settle > 0) await deps.sleep(settle);
    if (!(await deps.press("copy"))) return null;
    for (let waited = 0; ; waited += poll) {
      const text = cleanSelection(host.readText());
      if (text) return text;
      if (waited >= timeout) return null;
      await deps.sleep(poll);
    }
  } catch {
    return null;
  } finally {
    try { host.restore(saved); } catch { /* best effort */ }
  }
}

export interface PasteOptions {
  /** How long the app in front gets to read the clipboard before it is put back. */
  settleMs?: number;
}

export type PasteResult =
  | { pasted: true; restored: boolean }
  | { pasted: false; reason: "no-text" | "no-keystroke" | "failed" };

/**
 * Types `text` into the app in front by a paste: the clipboard is kept, the
 * text put on it, ⌘V pressed, and after a moment the old clipboard put back.
 * It is put back only while the text is still what is on it: a copy the user
 * made in that moment is theirs. When the keys cannot be pressed the text
 * stays on the clipboard, so a paste by hand still works.
 */
export async function pasteByKeystroke<S>(host: ClipboardHost<S>, deps: KeystrokeDeps, text: string, opts: PasteOptions = {}): Promise<PasteResult> {
  if (!text) return { pasted: false, reason: "no-text" };
  const settle = opts.settleMs ?? 400;
  let saved: S;
  try {
    saved = host.save();
    host.writeText(text);
  } catch {
    return { pasted: false, reason: "failed" };
  }
  let pressed = false;
  try {
    pressed = await deps.press("paste");
  } catch {
    pressed = false;
  }
  if (!pressed) return { pasted: false, reason: "no-keystroke" };
  await deps.sleep(settle);
  try {
    if (host.readText() !== text) return { pasted: true, restored: false };
    host.restore(saved);
    return { pasted: true, restored: true };
  } catch {
    return { pasted: true, restored: false };
  }
}
