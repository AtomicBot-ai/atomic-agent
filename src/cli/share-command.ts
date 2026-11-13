import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { getConfig } from "../config/index.js";
import {
  buildChatExport,
  renderChatExport,
  type ChatExport,
  type ChatExportFormat,
} from "../session/chat-export/index.js";
import {
  SessionStore,
  readSessionTitle,
  sessionSummaryCursorAfter,
  type SessionSummaryCursor,
} from "../session/index.js";
import { getAppVersion } from "../version.js";
import {
  askInTerminal,
  formatUploadPreview,
  isYes,
  uploadSecretGist,
  type GistUploadResult,
} from "./share-gist.js";

export const SHARE_HELP =
  [
    "atomic-agent share — save a chat as one file to send a colleague",
    "",
    "Writes your messages and the agent's replies to a single HTML (or",
    "Markdown) file. Tool output and reasoning are left out; keys, local",
    "paths, emails and IP addresses are replaced. Nothing is uploaded",
    "unless you pass --gist and then answer yes.",
    "",
    "Usage:",
    "  atomic-agent share [options]",
    "",
    "Options:",
    "  --session <id>   latest (default) or the chat id; a unique prefix is enough.",
    "                   latest = the newest chat in this folder, else the newest anywhere",
    "  --format <f>     html (default) or md (default md with --gist: GitHub shows",
    "                   Markdown as a page and HTML as source)",
    "  --out <file>     Where to write it (default <stateDir>/shared-chats/chat-<id>.<ext>)",
    "  --gist           Then offer to upload the file as a secret GitHub gist with gh.",
    "                   Shows what goes up and asks first; needs a terminal",
    "  --json           Print {ok, file, sessionId, messages, removed}; not with --gist",
    "",
    "Examples:",
    "  atag share",
    "  atag share --session s-0199a1 --out ~/Desktop/chat.html",
    "  atag share --gist",
  ].join("\n") + "\n";

export interface ShareArgs {
  session: string;
  /** null = not given: html, or md with --gist. */
  format: ChatExportFormat | null;
  out: string | null;
  gist: boolean;
  json: boolean;
}

export function parseShareArgs(args: string[]): ShareArgs | { error: string } | { help: true } {
  const parsed: ShareArgs = { session: "latest", format: null, out: null, gist: false, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i]!;
    const value = (): string | null => {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return null;
      i += 1;
      return next;
    };
    switch (flag) {
      case "-h":
      case "--help":
        return { help: true };
      case "--session": {
        const v = value();
        if (!v) return { error: "--session needs latest or a chat id" };
        parsed.session = v;
        break;
      }
      case "--format": {
        const v = value();
        if (v !== "html" && v !== "md") return { error: "--format must be html or md" };
        parsed.format = v;
        break;
      }
      case "--out": {
        const v = value();
        if (!v) return { error: "--out needs a file path" };
        parsed.out = v;
        break;
      }
      case "--gist":
        parsed.gist = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      default:
        return { error: `unknown option: ${flag}` };
    }
  }
  if (parsed.gist && parsed.json) {
    return { error: "--gist asks before uploading, so it cannot run with --json" };
  }
  return parsed;
}

/** What the command needs from the store; a narrow seam for tests. */
export type ShareSessionStore = Pick<
  SessionStore,
  "load" | "listSummaryPage" | "listChatLines" | "close"
>;

const PAGE = 200;
const MAX_PAGES = 25;

/** `latest`, an exact id, or a unique id prefix, to one stored chat id. */
export function resolveShareSession(
  store: Pick<ShareSessionStore, "load" | "listSummaryPage">,
  wanted: string,
  cwd: string,
): { id: string } | { error: string } {
  if (wanted === "latest") {
    const page = store.listSummaryPage({ limit: PAGE });
    const here = page.find((row) => row.workingDir === cwd) ?? page[0];
    return here ? { id: here.id } : { error: "there are no chats to share yet" };
  }
  if (store.load(wanted)) return { id: wanted };
  const matches: string[] = [];
  let after: SessionSummaryCursor | undefined;
  for (let n = 0; n < MAX_PAGES; n += 1) {
    const page = store.listSummaryPage(after ? { limit: PAGE, after } : { limit: PAGE });
    for (const row of page) if (row.id.startsWith(wanted)) matches.push(row.id);
    if (matches.length > 1 || page.length < PAGE) break;
    after = sessionSummaryCursorAfter(page) ?? undefined;
  }
  if (matches.length === 1) return { id: matches[0]! };
  if (matches.length === 0) return { error: `no chat with id ${wanted}` };
  return { error: `${wanted} matches more than one chat; give more of the id` };
}

export interface ShareDeps {
  openStore?: () => ShareSessionStore;
  stateDir?: () => string;
  cwd?: () => string;
  homeDir?: () => string;
  now?: () => Date;
  writeFile?: (file: string, content: string) => void;
  isTTY?: () => boolean;
  ask?: (prompt: string) => Promise<string>;
  upload?: (file: string, description: string) => Promise<GistUploadResult>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function shareCommand(args: string[], deps: ShareDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((t: string) => process.stdout.write(t));
  const err = deps.stderr ?? ((t: string) => process.stderr.write(t));
  const parsed = parseShareArgs(args);
  if ("help" in parsed) {
    out(SHARE_HELP);
    return 0;
  }
  if ("error" in parsed) {
    err(`${parsed.error}\n\n${SHARE_HELP}`);
    return 2;
  }

  const cwd = (deps.cwd ?? (() => process.cwd()))();
  const loaded = loadShareableChat(parsed.session, cwd, deps);
  if ("error" in loaded) {
    err(`${loaded.error}\n`);
    return 1;
  }
  const { chat, sessionId } = loaded;
  if (chat.messages.length === 0) {
    err(`chat ${sessionId} has no messages to share\n`);
    return 1;
  }

  const format = parsed.format ?? (parsed.gist ? "md" : "html");
  const content = renderChatExport(chat, format);
  const file = parsed.out
    ? resolve(cwd, parsed.out)
    : join((deps.stateDir ?? (() => getConfig().paths.stateDir))(), "shared-chats", `chat-${sessionId}.${format}`);
  (deps.writeFile ?? writeOwnerOnly)(file, content);

  if (parsed.json) {
    out(`${JSON.stringify({ ok: true, file, sessionId, format, messages: chat.messages.length, removed: chat.counts })}\n`);
    return 0;
  }
  out(`Saved ${chat.messages.length} messages to ${file}\n`);
  if (!parsed.gist) return 0;

  const isTTY = deps.isTTY ?? (() => process.stdin.isTTY === true && process.stderr.isTTY === true);
  if (!isTTY()) {
    err("Not uploaded: --gist asks before uploading and needs a terminal to ask in.\n");
    return 1;
  }
  err(formatUploadPreview(chat, file, Buffer.byteLength(content, "utf8")));
  const answer = await (deps.ask ?? askInTerminal)("Upload it as a secret gist? [y/N] ");
  if (!isYes(answer)) {
    out("Not uploaded. The file is still on this computer.\n");
    return 0;
  }
  const uploaded = await (deps.upload ?? uploadSecretGist)(file, `Atomic Agent chat: ${chat.title}`);
  if (!uploaded.ok) {
    err(`Not uploaded: ${uploaded.error}\n`);
    return 1;
  }
  out(`Uploaded: ${uploaded.url}\nSend this link to your colleague. Delete the gist there to stop sharing.\n`);
  return 0;
}

/** Find the chat, read its lines and build the redacted export; the store is closed either way. */
function loadShareableChat(
  wanted: string,
  cwd: string,
  deps: ShareDeps,
): { chat: ChatExport; sessionId: string } | { error: string } {
  const store = (deps.openStore ?? (() => new SessionStore({ dbFile: getConfig().paths.sessionsDbFile })))();
  try {
    const resolved = resolveShareSession(store, wanted, cwd);
    if ("error" in resolved) return resolved;
    const session = store.load(resolved.id);
    const lines = store.listChatLines(resolved.id);
    const chat = buildChatExport(
      {
        title: readSessionTitle(session?.metadata) ?? lines.find((l) => l.kind === "user")?.text ?? "",
        lines,
        exportedAt: (deps.now ?? (() => new Date()))(),
        appVersion: getAppVersion(),
      },
      {
        homeDir: (deps.homeDir ?? homedir)(),
        ...(session?.workingDir ? { workingDir: session.workingDir } : {}),
      },
    );
    return { chat, sessionId: resolved.id };
  } finally {
    store.close();
  }
}

function writeOwnerOnly(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
}
