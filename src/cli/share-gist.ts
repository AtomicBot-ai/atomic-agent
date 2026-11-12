import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";

import type { ChatExport } from "../session/chat-export/index.js";

/**
 * The upload half of `atomic-agent share --gist` (ATO-581). Nothing here
 * runs on its own: the command calls it only after writing the file,
 * printing what is in it and getting a typed "yes" in a terminal.
 *
 * The upload is `gh gist create <file> --desc <title>`: a SECRET gist
 * (gh's default; `--public` is never passed) on the account `gh` is
 * signed in to. The token stays inside gh; nothing secret goes on argv.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the program itself could not be started (ENOENT). */
  missing?: boolean;
}

export type RunCommand = (command: string, args: readonly string[]) => Promise<CommandResult>;

export type GistUploadResult = { ok: true; url: string } | { ok: false; error: string };

const GIST_URL = /https:\/\/gist\.github\.com\/\S+/;
const UPLOAD_TIMEOUT_MS = 60_000;

/** The exact argv handed to `gh`; pinned by a test so `--public` never sneaks in. */
export function gistCreateArgs(file: string, description: string): string[] {
  return ["gist", "create", file, "--desc", description];
}

export async function uploadSecretGist(
  file: string,
  description: string,
  run: RunCommand = runCommand,
): Promise<GistUploadResult> {
  const result = await run("gh", gistCreateArgs(file, description));
  if (result.missing) {
    return {
      ok: false,
      error: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.",
    };
  }
  if (result.code !== 0) {
    const reason = result.stderr.trim().split("\n").at(-1) ?? "";
    return {
      ok: false,
      error: `gh gist create failed${reason ? `: ${reason}` : ""}. Is gh signed in? Try \`gh auth status\`.`,
    };
  }
  const url = GIST_URL.exec(result.stdout)?.[0] ?? GIST_URL.exec(result.stderr)?.[0];
  if (!url) return { ok: false, error: "gh did not print a gist link." };
  return { ok: true, url };
}

const PREVIEW_MESSAGES = 4;
const PREVIEW_CHARS = 160;

/** Printed before the question: what goes up, where, and who can read it. */
export function formatUploadPreview(chat: ChatExport, file: string, bytes: number): string {
  const lines = [
    `About to upload ${file} (${formatBytes(bytes)}) as a secret GitHub gist:`,
    `  title:    ${chat.title}`,
    `  messages: ${chat.messages.length} (your messages and the agent's replies only)`,
    `  removed:  ${chat.counts.secrets} secret(s), ${chat.counts.paths} path(s), ` +
      `${chat.counts.personal} email/IP/link part(s), ${chat.counts.reasoning} reasoning block(s); ` +
      `tool output was never included`,
    "  first messages:",
  ];
  for (const message of chat.messages.slice(0, PREVIEW_MESSAGES)) {
    const who = message.role === "user" ? "you  " : "agent";
    lines.push(`    ${who} | ${oneLine(message.text)}`);
  }
  if (chat.messages.length > PREVIEW_MESSAGES) {
    lines.push(`    ... ${chat.messages.length - PREVIEW_MESSAGES} more`);
  }
  lines.push(
    "Open the file first if you want to read all of it: that file is exactly what is uploaded.",
    "A secret gist is not listed on your profile or in search, but anyone with the link can open it.",
    "You can delete it later at https://gist.github.com.",
  );
  return `${lines.join("\n")}\n`;
}

/** Only a typed y / yes counts; anything else, an empty line included, is a no. */
export function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export async function askInTerminal(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: UPLOAD_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          resolve({ code: 127, stdout: "", stderr: "", missing: true });
          return;
        }
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
