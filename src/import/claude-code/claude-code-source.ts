import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Read-only access to a `~/.claude` state directory (Claude Code). This
 * is the **only** file in the Claude Code import feature that touches
 * its physical layout; everything downstream operates on the neutral
 * types exported here.
 *
 * Layout:
 *  - `skills/<name>/SKILL.md`                — agent skills (same manifest
 *    family atomic-agent uses, so a skill imports as a directory copy).
 *  - `projects/<slug>/<uuid>.jsonl`          — session transcripts, one
 *    JSON event per line (`user` / `assistant` rows carry the messages).
 *  - `projects/<slug>/memory/*.md`           — per-project auto-memory
 *    notes; `MEMORY.md` is the index and is skipped.
 *  - `CLAUDE.md`                             — global user instructions.
 *  - `settings.json` `env` block             — provider keys (opt-in).
 *  - sibling file `~/.claude.json` `mcpServers` — MCP server configs.
 */
export class ClaudeCodeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCodeSourceError";
  }
}

/** A skill directory holding a `SKILL.md` manifest. */
export interface ClaudeCodeSkill {
  /** Directory basename — the skill's install name. */
  name: string;
  /** Absolute path to the skill's root directory. */
  dir: string;
}

/** One auto-memory note, or the global `CLAUDE.md` instructions file. */
export interface ClaudeCodeMemoryFile {
  /** Path relative to the state dir, used as the item's source id. */
  relPath: string;
  content: string;
}

/** A raw `mcpServers` entry, unvalidated — the mapper normalises it. */
export interface ClaudeCodeMcpServer {
  name: string;
  raw: Record<string, unknown>;
}

/** Lightweight session header; the transcript is read separately. */
export interface ClaudeCodeSessionMeta {
  /** Transcript file basename without `.jsonl` (the session uuid). */
  id: string;
  /** Absolute path to the `<uuid>.jsonl` transcript. */
  file: string;
  /** File mtime in ms — the cheap recency key the listing sorts by. */
  mtimeMs: number;
}

/** A content block inside a projected transcript message. */
export type ClaudeCodeBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolUse"; id: string | null; name: string; args: Record<string, unknown> }
  | { type: "toolResult"; toolUseId: string | null; text: string; isError: boolean };

/** A projected `user` / `assistant` transcript row. */
export interface ClaudeCodeMessage {
  role: "user" | "assistant";
  blocks: ClaudeCodeBlock[];
  atMs: number;
}

/** A fully-read session: header fields plus the projected messages. */
export interface ClaudeCodeSessionData {
  id: string;
  cwd: string | null;
  title: string | null;
  messages: ClaudeCodeMessage[];
}

export class ClaudeCodeSource {
  constructor(private readonly sourceDir: string) {}

  skillsDir(): string {
    return join(this.sourceDir, "skills");
  }

  projectsDir(): string {
    return join(this.sourceDir, "projects");
  }

  settingsPath(): string {
    return join(this.sourceDir, "settings.json");
  }

  globalClaudeMdPath(): string {
    return join(this.sourceDir, "CLAUDE.md");
  }

  /**
   * `~/.claude.json` — Claude Code keeps `mcpServers` in a sibling file
   * next to the state dir, not inside it.
   */
  mcpConfigPath(): string {
    return join(dirname(this.sourceDir), ".claude.json");
  }

  hasSkills(): boolean {
    return existsSync(this.skillsDir());
  }

  hasProjects(): boolean {
    return existsSync(this.projectsDir());
  }

  /** Skill dirs that hold a `SKILL.md`, sorted by name. */
  listSkills(): ClaudeCodeSkill[] {
    const root = this.skillsDir();
    if (!existsSync(root)) return [];
    const skills: ClaudeCodeSkill[] = [];
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      if (!existsSync(join(dir, "SKILL.md"))) continue;
      skills.push({ name: entry, dir });
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return skills;
  }

  /**
   * Auto-memory notes from every project's `memory/` dir plus the global
   * `CLAUDE.md`. `MEMORY.md` (the index Claude Code regenerates from the
   * notes) is skipped; empty files are skipped.
   */
  listMemoryFiles(): ClaudeCodeMemoryFile[] {
    const files: ClaudeCodeMemoryFile[] = [];
    const globalMd = this.globalClaudeMdPath();
    if (existsSync(globalMd)) {
      const content = readFileSync(globalMd, "utf8").trim();
      if (content.length > 0) files.push({ relPath: "CLAUDE.md", content });
    }
    const projects = this.projectsDir();
    if (!existsSync(projects)) return files;
    for (const slug of sortedEntries(projects)) {
      const memoryDir = join(projects, slug, "memory");
      if (!existsSync(memoryDir)) continue;
      for (const entry of sortedEntries(memoryDir)) {
        if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
        const path = join(memoryDir, entry);
        let content: string;
        try {
          content = readFileSync(path, "utf8").trim();
        } catch {
          continue;
        }
        if (content.length === 0) continue;
        files.push({
          relPath: join("projects", slug, "memory", entry),
          content,
        });
      }
    }
    return files;
  }

  /**
   * Raw `mcpServers` entries from `~/.claude.json`. Returns an empty
   * list when the file is missing or holds no such block; malformed JSON
   * throws a `ClaudeCodeSourceError` (a broken config file is worth a
   * loud error item, not a silent zero).
   */
  readMcpServers(): ClaudeCodeMcpServer[] {
    const path = this.mcpConfigPath();
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClaudeCodeSourceError(`failed to parse ${path}: ${message}`);
    }
    if (!parsed || typeof parsed !== "object") return [];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return [];
    }
    const result: ClaudeCodeMcpServer[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      result.push({ name, raw: raw as Record<string, unknown> });
    }
    return result;
  }

  /**
   * Read `settings.json`'s `env` block and return only the keys present
   * in `allowlist` with non-empty string values.
   */
  readEnvKeys(allowlist: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    const path = this.settingsPath();
    if (!existsSync(path)) return result;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return result;
    }
    if (!parsed || typeof parsed !== "object") return result;
    const env = (parsed as { env?: unknown }).env;
    if (!env || typeof env !== "object" || Array.isArray(env)) return result;
    const allowed = new Set(allowlist);
    for (const [key, value] of Object.entries(env)) {
      if (!allowed.has(key)) continue;
      if (typeof value !== "string" || value.length === 0) continue;
      result.set(key, value);
    }
    return result;
  }

  /**
   * List transcript headers across every project, newest-first by file
   * mtime. Recency comes from the mtime rather than a parse because a
   * listing that opened a gigabyte of JSONL to sort itself would make
   * every preview pay for sessions a `limit` then discards.
   */
  listSessions(): ClaudeCodeSessionMeta[] {
    const projects = this.projectsDir();
    if (!existsSync(projects)) return [];
    const metas: ClaudeCodeSessionMeta[] = [];
    for (const slug of sortedEntries(projects)) {
      const projectDir = join(projects, slug);
      let entries: string[];
      try {
        entries = readdirSync(projectDir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const file = join(projectDir, entry);
        let mtimeMs: number;
        try {
          const stats = statSync(file);
          if (!stats.isFile()) continue;
          mtimeMs = stats.mtimeMs;
        } catch {
          continue;
        }
        metas.push({ id: entry.slice(0, -".jsonl".length), file, mtimeMs });
      }
    }
    metas.sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    return metas;
  }

  /**
   * Read one transcript into a neutral session. Meta rows (`system`,
   * `queue-operation`, attachments, …) are skipped; sidechain rows
   * (subagent transcripts interleaved into the same file) are skipped;
   * `custom-title` wins over `ai-title` for the session title.
   */
  readSession(meta: ClaudeCodeSessionMeta): ClaudeCodeSessionData {
    let text: string;
    try {
      text = readFileSync(meta.file, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ClaudeCodeSourceError(`failed to read ${meta.file}: ${message}`);
    }
    let cwd: string | null = null;
    let customTitle: string | null = null;
    let aiTitle: string | null = null;
    const messages: ClaudeCodeMessage[] = [];
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
      const type = event.type;
      if (type === "custom-title" && typeof event.customTitle === "string") {
        customTitle = event.customTitle;
        continue;
      }
      if (type === "ai-title" && typeof event.aiTitle === "string") {
        aiTitle = event.aiTitle;
        continue;
      }
      if (type !== "user" && type !== "assistant") continue;
      if (event.isSidechain === true) continue;
      if (cwd === null && typeof event.cwd === "string") cwd = event.cwd;
      const projected = projectMessage(type, event);
      if (projected) messages.push(projected);
    }
    return {
      id: meta.id,
      cwd,
      title: customTitle ?? aiTitle,
      messages,
    };
  }
}

function sortedEntries(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.sort();
}

function projectMessage(
  role: "user" | "assistant",
  event: Record<string, unknown>,
): ClaudeCodeMessage | null {
  const message = event.message;
  if (!message || typeof message !== "object") return null;
  const content = (message as { content?: unknown }).content;
  const blocks = projectBlocks(content);
  if (blocks.length === 0) return null;
  const atMs =
    typeof event.timestamp === "string" ? isoToMs(event.timestamp) ?? 0 : 0;
  return { role, blocks, atMs };
}

function projectBlocks(content: unknown): ClaudeCodeBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeCodeBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.length > 0) {
          blocks.push({ type: "text", text: block.text });
        }
        break;
      case "thinking":
        if (typeof block.thinking === "string" && block.thinking.length > 0) {
          blocks.push({ type: "thinking", thinking: block.thinking });
        }
        break;
      case "tool_use": {
        const name = block.name;
        if (typeof name !== "string" || name.length === 0) break;
        blocks.push({
          type: "toolUse",
          id: typeof block.id === "string" ? block.id : null,
          name,
          args:
            block.input && typeof block.input === "object" &&
            !Array.isArray(block.input)
              ? (block.input as Record<string, unknown>)
              : {},
        });
        break;
      }
      case "tool_result":
        blocks.push({
          type: "toolResult",
          toolUseId:
            typeof block.tool_use_id === "string" ? block.tool_use_id : null,
          text: flattenResultContent(block.content),
          isError: block.is_error === true,
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}

/** Tool results carry a string or a list of text blocks; flatten both. */
function flattenResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

function isoToMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
