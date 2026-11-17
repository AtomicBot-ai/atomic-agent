/* ATO-581 — the chat row's "Share chat…": one redacted file, and a secret
   gist only after an explicit yes.

   The agent writes the file (`atag share --session <id> --out <file>
   --format html|md --json`, src/cli/share-command.ts): only the person's
   messages and the agent's replies, with keys, local paths, emails, IP
   addresses and reasoning removed. The desktop picks where (a save
   dialog), then says what was removed and offers three ways on: Done,
   Show in folder, Create secret gist….

   The gist is the only way off the machine and it is asked twice: the
   offer, then a confirm that says who can open a secret gist (anyone with
   the link), with Cancel as the default button. Only then does it run
   `gh gist create <file> --desc <title>`: a SECRET gist (no `--public`,
   pinned by test/chat-share.test.mjs) on the account `gh` is signed in
   to; the token never leaves gh. GitHub shows Markdown as a page and HTML
   as source, so an HTML save uploads a Markdown copy written by the same
   command. Same flow as ChatGPT / Claude "Share chat" (a preview, then a
   link) and Claude Code `/export`, minus any server of ours. */

import type { BrowserWindow, Dialog, IpcMain, MessageBoxOptions, SaveDialogOptions } from "electron";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { CliResult } from "./agent-cli.js";

/** `atag share --json`'s line. */
export interface ShareWire {
  ok: true;
  file: string;
  sessionId: string;
  format: "html" | "md";
  messages: number;
  removed: { secrets?: number; paths?: number; personal?: number; reasoning?: number };
}

export interface GhResult { code: number; stdout: string; stderr: string; missing?: boolean }

export interface ChatShareDeps {
  ipcMain: Pick<IpcMain, "handle">;
  dialog: Pick<Dialog, "showSaveDialog" | "showMessageBox">;
  window: () => BrowserWindow | null;
  /** `atag <args>` (agent-cli.ts atagRun). */
  runAgent: (args: string[]) => Promise<CliResult>;
  /** `gh <args>`, with the app's PATH (state-dir.ts agentEnv). */
  runGh: (args: string[]) => Promise<GhResult>;
  /** The agent runs on another computer: its chats are not in this computer's store. */
  isRemote: () => boolean;
  showInFolder: (path: string) => void;
  copyText: (text: string) => void;
  openUrl: (url: string) => void;
  readText?: (path: string) => Promise<string>;
}

export type ChatShareResult =
  | { ok: true; path: string; gistUrl?: string; gistError?: string }
  | { ok: false; reason: "canceled" | "bad-id" }
  | { ok: false; reason: "failed"; error: string };

export const SHARE_FILTERS: NonNullable<SaveDialogOptions["filters"]> = [
  { name: "Web page", extensions: ["html"] },
  { name: "Markdown", extensions: ["md"] },
];

/** The exact argv handed to `gh`: a secret gist, never `--public`. */
export function shareGistArgs(file: string, title: string): string[] {
  return ["gist", "create", file, "--desc", `Atomic Agent chat: ${title || "untitled"}`];
}

/** The `atag share` argv for one chat and one file. */
export function shareAgentArgs(id: string, format: "html" | "md", out?: string): string[] {
  return ["share", "--session", id, "--format", format, ...(out ? ["--out", out] : []), "--json"];
}

/** `.md` / `.markdown` is Markdown; anything else is the HTML page (and gets `.html`). */
export function shareTarget(filePath: string): { format: "html" | "md"; path: string } {
  if (/\.(md|markdown)$/i.test(filePath)) return { format: "md", path: filePath };
  if (/\.html?$/i.test(filePath)) return { format: "html", path: filePath };
  return { format: "html", path: `${filePath}.html` };
}

/** The last JSON line `atag share --json` printed, or null. */
export function parseShareWire(stdout: string): ShareWire | null {
  const lines = String(stdout || "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const v = JSON.parse(line) as Partial<ShareWire>;
      if (v && v.ok === true && typeof v.file === "string") return v as ShareWire;
    } catch { /* not the JSON line */ }
  }
  return null;
}

/** "Removed: 2 keys, 5 folder paths…" in plain words; "" when nothing was. */
export function removedLine(removed: ShareWire["removed"] | undefined): string {
  const r = removed ?? {};
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string): void => {
    if (typeof n === "number" && n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(r.secrets, "key or secret", "keys or secrets");
  add(r.paths, "folder path", "folder paths");
  add(r.personal, "email, IP or link part", "emails, IPs or link parts");
  add(r.reasoning, "reasoning block", "reasoning blocks");
  return parts.length ? `Removed: ${parts.join(", ")}.` : "Nothing needed removing.";
}

/** The chat title: the Markdown file's first `# ` line (already redacted by the agent). */
export function titleFromMarkdown(md: string): string {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? (m[1] ?? "").trim().slice(0, 120) : "";
}

/** What the window shows for a failed `atag share`. */
export function shareErrorText(res: CliResult): string {
  const text = `${res.stderr || ""}\n${res.error || ""}`;
  if (/unknown command:\s*share/.test(text)) return "This agent version cannot share chats. Update Atomic Agent.";
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean)[0];
  return line || "The agent did not write the file.";
}

const GIST_URL = /https:\/\/gist\.github\.com\/\S+/;

/** `gh gist create`'s answer, as a link or a reason. */
export function gistOutcome(res: GhResult): { url: string } | { error: string } {
  if (res.missing) return { error: "GitHub CLI (gh) is not installed. Install it from cli.github.com, then run `gh auth login` in Terminal." };
  if (res.code !== 0) {
    const reason = res.stderr.trim().split("\n").at(-1) ?? "";
    return { error: `gh gist create failed${reason ? `: ${reason}` : ""}. Is gh signed in? Try \`gh auth status\` in Terminal.` };
  }
  const url = GIST_URL.exec(res.stdout)?.[0] ?? GIST_URL.exec(res.stderr)?.[0];
  return url ? { url } : { error: "gh did not print a gist link." };
}

async function box(deps: ChatShareDeps, opts: MessageBoxOptions): Promise<number> {
  const owner = deps.window();
  const res = owner ? await deps.dialog.showMessageBox(owner, opts) : await deps.dialog.showMessageBox(opts);
  return res.response;
}

/** Save dialog → `atag share` → what was removed → (opt-in) secret gist. */
export async function shareChat(deps: ChatShareDeps, id: unknown): Promise<ChatShareResult> {
  if (typeof id !== "string" || !id || id.length > 256 || id.startsWith("-")) return { ok: false, reason: "bad-id" };
  if (deps.isRemote()) return { ok: false, reason: "failed", error: "Share works for chats stored on this computer. This window is connected to an agent on another one." };
  const owner = deps.window();
  const opts: SaveDialogOptions = { title: "Share chat", defaultPath: `chat-${id.slice(0, 8)}.html`, filters: SHARE_FILTERS };
  const picked = owner ? await deps.dialog.showSaveDialog(owner, opts) : await deps.dialog.showSaveDialog(opts);
  if (picked.canceled || !picked.filePath) return { ok: false, reason: "canceled" };
  const target = shareTarget(picked.filePath);

  const saved = await deps.runAgent(shareAgentArgs(id, target.format, target.path));
  const wire = saved.ok ? parseShareWire(saved.stdout) : null;
  if (!wire) return { ok: false, reason: "failed", error: shareErrorText(saved) };

  const next = await box(deps, {
    type: "info",
    message: "Saved a redacted copy of this chat",
    detail: `${wire.messages} messages: yours and the agent's replies. Tool output and reasoning are never included. ${removedLine(wire.removed)}\n\n${wire.file}`,
    buttons: ["Done", "Show in folder", "Create secret gist…"],
    defaultId: 0,
    cancelId: 0,
  });
  if (next === 1) deps.showInFolder(wire.file);
  if (next !== 2) return { ok: true, path: wire.file };

  const sure = await box(deps, {
    type: "warning",
    message: "Upload this chat as a secret GitHub gist?",
    detail: "It goes to the GitHub account the gh command is signed in to. A secret gist is not listed on your profile or in search, "
      + "but anyone with the link can open it. You can delete it later at gist.github.com. "
      + "Open the saved file first if you want to read exactly what goes up.",
    buttons: ["Cancel", "Upload"],
    defaultId: 0,
    cancelId: 0,
  });
  if (sure !== 1) return { ok: true, path: wire.file };

  // GitHub draws Markdown as a page and HTML as source: an HTML save uploads the Markdown copy.
  let mdFile = wire.file;
  if (wire.format !== "md") {
    const md = await deps.runAgent(shareAgentArgs(id, "md"));
    const mdWire = md.ok ? parseShareWire(md.stdout) : null;
    if (!mdWire) return { ok: true, path: wire.file, gistError: shareErrorText(md) };
    mdFile = mdWire.file;
  }
  const title = titleFromMarkdown(await (deps.readText ?? ((p) => readFile(p, "utf8")))(mdFile).catch(() => ""));
  const outcome = gistOutcome(await deps.runGh(shareGistArgs(mdFile, title)));
  if ("error" in outcome) return { ok: true, path: wire.file, gistError: outcome.error };
  deps.copyText(outcome.url);
  const open = await box(deps, {
    type: "info",
    message: "Uploaded as a secret gist",
    detail: `The link is copied: ${outcome.url}\nSend it to your colleague. Delete the gist on GitHub to stop sharing.`,
    buttons: ["Done", "Open link"],
    defaultId: 0,
    cancelId: 0,
  });
  if (open === 1) deps.openUrl(outcome.url);
  return { ok: true, path: wire.file, gistUrl: outcome.url };
}

/** `gh <args>` with the given environment (the app's PATH reaches Homebrew's gh); a minute at most. */
export function ghRunner(env: () => NodeJS.ProcessEnv): (args: string[]) => Promise<GhResult> {
  return (args) => new Promise((resolve) => {
    execFile("gh", args, { env: env(), timeout: 60_000, windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") { resolve({ code: 127, stdout: "", stderr: "", missing: true }); return; }
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function registerChatShareIpc(deps: ChatShareDeps): void {
  deps.ipcMain.handle("agent:shareSession", (_event, id: unknown) => shareChat(deps, id));
}
