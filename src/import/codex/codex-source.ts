import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Read-only access to a `~/.codex` state directory (Codex CLI). This is
 * the **only** file in the Codex import feature that touches its
 * physical layout; everything downstream operates on the neutral types
 * exported here.
 *
 * Layout:
 *  - `sessions/**∕rollout-*.jsonl` — rollout transcripts, one JSON event
 *    per line (date-sharded subdirs on current builds, flat on old ones;
 *    the listing scans recursively and takes any `.jsonl`).
 *  - `skills/<name>/SKILL.md`      — agent skills (same manifest family).
 *  - `AGENTS.md`                   — global user instructions.
 *  - `auth.json` `OPENAI_API_KEY`  — provider key (opt-in).
 */
export class CodexSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSourceError";
  }
}

/** A skill directory holding a `SKILL.md` manifest. */
export interface CodexSkill {
  name: string;
  dir: string;
}

/** Lightweight rollout header; the transcript is read separately. */
export interface CodexSessionMeta {
  /** Session id from the `session_meta` line, or the file basename. */
  id: string;
  /** Absolute path to the rollout `.jsonl`. */
  file: string;
  /** File mtime in ms — the cheap recency key the listing sorts by. */
  mtimeMs: number;
}

/** A content block inside a projected rollout item. */
export type CodexBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string | null; name: string; args: Record<string, unknown> }
  | { type: "toolResult"; callId: string | null; text: string };

/** A projected rollout `response_item`. */
export interface CodexMessage {
  role: "user" | "assistant" | "tool";
  blocks: CodexBlock[];
  atMs: number;
}

/** A fully-read rollout: header fields plus the projected items. */
export interface CodexSessionData {
  id: string;
  cwd: string | null;
  startedAtMs: number;
  messages: CodexMessage[];
}

export class CodexSource {
  constructor(private readonly sourceDir: string) {}

  sessionsDir(): string {
    return join(this.sourceDir, "sessions");
  }

  skillsDir(): string {
    return join(this.sourceDir, "skills");
  }

  agentsMdPath(): string {
    return join(this.sourceDir, "AGENTS.md");
  }

  authPath(): string {
    return join(this.sourceDir, "auth.json");
  }

  hasSessions(): boolean {
    return existsSync(this.sessionsDir());
  }

  /** Skill dirs that hold a `SKILL.md`, sorted by name. */
  listSkills(): CodexSkill[] {
    const root = this.skillsDir();
    if (!existsSync(root)) return [];
    const skills: CodexSkill[] = [];
    for (const entry of readdirSync(root).sort()) {
      const dir = join(root, entry);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      skills.push({ name: entry, dir });
    }
    return skills;
  }

  /** `AGENTS.md` content, or `null` when absent or empty. */
  readAgentsMd(): string | null {
    const path = this.agentsMdPath();
    if (!existsSync(path)) return null;
    let content: string;
    try {
      content = readFileSync(path, "utf8").trim();
    } catch {
      return null;
    }
    return content.length > 0 ? content : null;
  }

  /**
   * Read `auth.json` and return only the keys present in `allowlist`
   * with non-empty string values (ChatGPT-token logins keep the key
   * `null`, which reads as "nothing to migrate").
   */
  readAuthKeys(allowlist: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    const path = this.authPath();
    if (!existsSync(path)) return result;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return result;
    }
    if (!parsed || typeof parsed !== "object") return result;
    const obj = parsed as Record<string, unknown>;
    for (const key of allowlist) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) result.set(key, value);
    }
    return result;
  }

  /**
   * List rollout headers, newest-first by file mtime. Recency comes from
   * the mtime rather than a parse for the same reason the Claude Code
   * listing does it: sorting must not read what a `limit` then discards.
   */
  listSessions(): CodexSessionMeta[] {
    const root = this.sessionsDir();
    if (!existsSync(root)) return [];
    const metas: CodexSessionMeta[] = [];
    walkJsonlFiles(root, (file) => {
      let mtimeMs: number;
      try {
        const stats = statSync(file);
        if (!stats.isFile()) return;
        mtimeMs = stats.mtimeMs;
      } catch {
        return;
      }
      const basename = file.slice(file.lastIndexOf("/") + 1);
      metas.push({
        id: basename.replace(/^rollout-/, "").replace(/\.jsonl$/, ""),
        file,
        mtimeMs,
      });
    });
    metas.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return metas;
  }

  /**
   * Read one rollout into a neutral session. `session_meta` supplies the
   * id/cwd/start; `response_item` rows project onto messages; event and
   * turn-context rows are skipped. Instruction wrappers Codex injects as
   * user messages (`<user_instructions>`, `<environment_context>`) are
   * not things the operator said, and are dropped.
   */
  readSession(meta: CodexSessionMeta): CodexSessionData {
    let text: string;
    try {
      text = readFileSync(meta.file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CodexSourceError(`failed to read ${meta.file}: ${message}`);
    }
    let id = meta.id;
    let cwd: string | null = null;
    let startedAtMs = 0;
    const messages: CodexMessage[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let event: Record<string, unknown>;
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== "object") continue;
        event = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const payload = event.payload;
      if (!payload || typeof payload !== "object") continue;
      const p = payload as Record<string, unknown>;
      const atMs =
        typeof event.timestamp === "string"
          ? isoToMs(event.timestamp) ?? 0
          : 0;
      if (event.type === "session_meta") {
        if (typeof p.id === "string") id = p.id;
        if (typeof p.cwd === "string") cwd = p.cwd;
        if (startedAtMs === 0) startedAtMs = atMs;
        continue;
      }
      if (event.type !== "response_item") continue;
      const projected = projectResponseItem(p, atMs);
      if (projected) messages.push(projected);
    }
    return { id, cwd, startedAtMs, messages };
  }
}

/** Depth-first walk collecting every `.jsonl` under `root`. */
function walkJsonlFiles(root: string, visit: (file: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      walkJsonlFiles(path, visit);
    } else if (entry.endsWith(".jsonl")) {
      visit(path);
    }
  }
}

function projectResponseItem(
  p: Record<string, unknown>,
  atMs: number,
): CodexMessage | null {
  switch (p.type) {
    case "message": {
      if (p.role !== "user" && p.role !== "assistant") return null;
      const blocks = projectMessageContent(p.content);
      if (blocks.length === 0) return null;
      if (p.role === "user" && isInstructionWrapper(blocks)) return null;
      return { role: p.role, blocks, atMs };
    }
    case "reasoning": {
      const summary = joinSummary(p.summary);
      if (summary.length === 0) return null;
      return {
        role: "assistant",
        blocks: [{ type: "thinking", thinking: summary }],
        atMs,
      };
    }
    case "function_call": {
      const name = typeof p.name === "string" ? p.name : null;
      if (!name) return null;
      return {
        role: "assistant",
        blocks: [
          {
            type: "toolCall",
            id: typeof p.call_id === "string" ? p.call_id : null,
            name,
            args: parseArguments(p.arguments),
          },
        ],
        atMs,
      };
    }
    case "function_call_output": {
      return {
        role: "tool",
        blocks: [
          {
            type: "toolResult",
            callId: typeof p.call_id === "string" ? p.call_id : null,
            text: flattenOutput(p.output),
          },
        ],
        atMs,
      };
    }
    default:
      return null;
  }
}

function projectMessageContent(content: unknown): CodexBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: CodexBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const type = block.type;
    if (type !== "input_text" && type !== "output_text" && type !== "text") {
      continue;
    }
    if (typeof block.text === "string" && block.text.length > 0) {
      blocks.push({ type: "text", text: block.text });
    }
  }
  return blocks;
}

/** True when every text block is a `<user_instructions>`-style wrapper. */
function isInstructionWrapper(blocks: readonly CodexBlock[]): boolean {
  const texts = blocks.filter(
    (b): b is Extract<CodexBlock, { type: "text" }> => b.type === "text",
  );
  if (texts.length === 0) return false;
  return texts.every((b) => /^<[a-z_]+>/i.test(b.text.trimStart()));
}

function joinSummary(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const raw of summary) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (typeof block.text === "string" && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    if (value.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { _raw: parsed };
    } catch {
      return { _raw: value };
    }
  }
  return {};
}

/** Outputs arrive as a string or as `{ content, … }`; flatten both. */
function flattenOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const content = (output as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}

function isoToMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
