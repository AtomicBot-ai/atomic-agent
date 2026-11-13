import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import JSZip from "jszip";

/**
 * Read-only access to the Claude app's data export (claude.ai and the
 * Claude desktop app share one account, so one export covers both):
 * Settings › Privacy › Export data mails a link to a `.zip` holding
 *
 *  - `conversations.json` — an array of
 *    `{uuid, name, created_at, updated_at, chat_messages: [{uuid, sender:
 *    "human"|"assistant", text, content: [{type: "text", text} |
 *    {type: "thinking", thinking} | …], created_at, attachments:
 *    [{file_name, extracted_content}], files: [{file_name}]}]}`
 *  - `projects.json` — an array of `{uuid, name, description,
 *    prompt_template, docs: [{uuid, filename, content}]}`
 *  - `users.json` — the account; never read.
 *
 * The export is the only documented way out: the desktop app's own local
 * storage is not a published format and is not read here.
 *
 * Whether a conversation says which project it was in varies: exports
 * seen so far carry no link, so a `project_uuid` / `project_id` field or
 * a `project: {uuid, name}` object is honoured when present and nothing
 * is guessed when it is not.
 *
 * Accepts the `.zip` as downloaded or the folder it unpacks to. Files
 * may sit one folder down inside the zip; they are found by name.
 */
export class ClaudeAppSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAppSourceError";
  }
}

export interface ClaudeAppMessage {
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  /** File names attached to the message (their text is not copied). */
  attachments: string[];
  atMs: number;
}

export interface ClaudeAppConversation {
  uuid: string;
  name: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  /** The project the export says it was in, if it says. */
  projectUuid: string | null;
  projectName: string | null;
  messages: ClaudeAppMessage[];
}

export interface ClaudeAppProjectDoc {
  filename: string;
  content: string;
}

export interface ClaudeAppProject {
  uuid: string;
  name: string;
  description: string;
  /** The project's custom instructions. */
  promptTemplate: string;
  docs: ClaudeAppProjectDoc[];
}

export interface ClaudeAppExport {
  conversations: ClaudeAppConversation[];
  projects: ClaudeAppProject[];
  /** Whether any conversation named its project. */
  linksProjects: boolean;
}

export class ClaudeAppSource {
  constructor(private readonly path: string) {}

  location(): string {
    return this.path;
  }

  /** Read and project the export. A missing `conversations.json` is an error. */
  async load(): Promise<ClaudeAppExport> {
    const files = await this.readFiles(["conversations.json", "projects.json"]);
    const conversationsText = files.get("conversations.json");
    if (conversationsText === undefined) {
      throw new ClaudeAppSourceError(
        `no conversations.json in ${this.path} (expected the Claude data export .zip or its folder)`,
      );
    }
    const conversations = parseConversations(
      parseJson(conversationsText, "conversations.json"),
    );
    const projectsText = files.get("projects.json");
    const projects =
      projectsText === undefined
        ? []
        : parseProjects(parseJson(projectsText, "projects.json"));
    return {
      conversations,
      projects,
      linksProjects: conversations.some((c) => c.projectUuid !== null),
    };
  }

  private async readFiles(names: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!existsSync(this.path)) {
      throw new ClaudeAppSourceError(`not found: ${this.path}`);
    }
    if (statSync(this.path).isDirectory()) {
      for (const name of names) {
        const file = join(this.path, name);
        if (existsSync(file)) out.set(name, readFileSync(file, "utf8"));
      }
      return out;
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readFileSync(this.path));
    } catch (err) {
      throw new ClaudeAppSourceError(
        `cannot open ${this.path} as a zip: ${errorMessage(err)}`,
      );
    }
    // Shallowest match wins, so a nested copy never shadows the top one.
    const entries = Object.values(zip.files)
      .filter((f) => !f.dir && names.includes(basename(f.name)))
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length);
    for (const entry of entries) {
      const name = basename(entry.name);
      if (out.has(name)) continue;
      out.set(name, await entry.async("string"));
    }
    return out;
  }
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ClaudeAppSourceError(`cannot parse ${name}: ${errorMessage(err)}`);
  }
}

export function parseConversations(raw: unknown): ClaudeAppConversation[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaudeAppConversation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const uuid = str(c.uuid);
    if (!uuid) continue;
    const createdAtMs = isoMs(c.created_at) ?? 0;
    const updatedAtMs = isoMs(c.updated_at) ?? createdAtMs;
    const project =
      c.project && typeof c.project === "object" && !Array.isArray(c.project)
        ? (c.project as Record<string, unknown>)
        : null;
    const projectUuid =
      str(c.project_uuid) ?? str(c.project_id) ?? (project ? str(project.uuid) : null);
    const messages: ClaudeAppMessage[] = [];
    const rows = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    for (const row of rows) {
      const m = projectMessage(row, createdAtMs);
      if (m) messages.push(m);
    }
    out.push({
      uuid,
      name: str(c.name),
      createdAtMs,
      updatedAtMs,
      projectUuid,
      projectName: project ? str(project.name) : null,
      messages,
    });
  }
  return out;
}

function projectMessage(raw: unknown, fallbackMs: number): ClaudeAppMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const role =
    m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
  if (!role) return null;
  const texts: string[] = [];
  const thoughts: string[] = [];
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string" && b.text) texts.push(b.text);
      else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) {
        thoughts.push(b.thinking);
      }
    }
  }
  // Older exports have only `text`; newer ones carry both, `content` being the full one.
  const text = texts.length > 0 ? texts.join("\n") : (str(m.text) ?? "");
  const attachments: string[] = [];
  for (const key of ["attachments", "files"] as const) {
    const list = m[key];
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const name = a && typeof a === "object" ? str((a as Record<string, unknown>).file_name) : null;
      if (name && !attachments.includes(name)) attachments.push(name);
    }
  }
  if (!text && thoughts.length === 0 && attachments.length === 0) return null;
  return {
    role,
    text,
    reasoning: thoughts.join("\n"),
    attachments,
    atMs: isoMs(m.created_at) ?? fallbackMs,
  };
}

export function parseProjects(raw: unknown): ClaudeAppProject[] {
  if (!Array.isArray(raw)) return [];
  const out: ClaudeAppProject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const uuid = str(p.uuid);
    const name = str(p.name);
    if (!uuid || !name) continue;
    // Claude's own sample project ("How to use Claude"), not the person's.
    if (p.is_starter_project === true) continue;
    const docs: ClaudeAppProjectDoc[] = [];
    if (Array.isArray(p.docs)) {
      for (const d of p.docs) {
        if (!d || typeof d !== "object") continue;
        const doc = d as Record<string, unknown>;
        const content = str(doc.content);
        if (!content) continue;
        docs.push({ filename: str(doc.filename) ?? "document", content });
      }
    }
    out.push({
      uuid,
      name,
      description: str(p.description) ?? "",
      promptTemplate: str(p.prompt_template) ?? "",
      docs,
    });
  }
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function isoMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
