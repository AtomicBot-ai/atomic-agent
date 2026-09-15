import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  listPiFormatSessions,
  readPiFormatSession,
  type PiSessionData,
  type PiSessionMeta,
} from "../pi/pi-session-format.js";
import { listSkillDirs, type PiSkill } from "../pi/pi-source.js";

/**
 * Read-only access to an Oh-My-Pi state directory (`~/.omp/agent`).
 * Oh-My-Pi is a hard fork of Pi: sessions keep Pi's file format (the
 * listing/parsing is reused from `../pi/pi-session-format.ts`), while
 * skills discovery and MCP support are its own.
 *
 * Layout:
 *  - `skills/<name>/SKILL.md` — one level only; unlike upstream Pi,
 *    Oh-My-Pi's discovery is non-recursive, so nested grouping dirs
 *    are deliberately not scanned. Auto-learned skills under
 *    `managed-skills/` are not imported.
 *  - `sessions/<cwd-slug>/<timestamp>_<id>.jsonl` — Pi's format.
 *  - `mcp.json` — `mcpServers` map plus the `disabledServers` /
 *    `enabledServers` lists; the default profile only.
 */
export class OhMyPiSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OhMyPiSourceError";
  }
}

/** A raw `mcpServers` entry, unvalidated — the mapper normalises it. */
export interface OhMyPiMcpServer {
  name: string;
  raw: Record<string, unknown>;
  /**
   * Switched off in `mcp.json`, resolved the way Oh-My-Pi itself does:
   * the `disabledServers` denylist always wins, and the entry's own
   * `enabled: false` counts unless `enabledServers` force-enables it
   * back on. Imported as a disabled server rather than dropped, so the
   * migrated config says what the source said.
   */
  disabled: boolean;
}

export class OhMyPiSource {
  constructor(private readonly sourceDir: string) {}

  skillsDir(): string {
    return join(this.sourceDir, "skills");
  }

  sessionsDir(): string {
    return join(this.sourceDir, "sessions");
  }

  mcpConfigPath(): string {
    return join(this.sourceDir, "mcp.json");
  }

  hasSkills(): boolean {
    return existsSync(this.skillsDir());
  }

  hasSessions(): boolean {
    return existsSync(this.sessionsDir());
  }

  /** Skill dirs holding a `SKILL.md`, one level — Oh-My-Pi's contract. */
  listSkills(): PiSkill[] {
    return listSkillDirs(this.skillsDir(), { recursive: false });
  }

  listSessions(): PiSessionMeta[] {
    return listPiFormatSessions(this.sessionsDir());
  }

  readSession(meta: PiSessionMeta): PiSessionData {
    return readPiFormatSession(meta);
  }

  /**
   * Raw `mcpServers` entries from `mcp.json`, each stamped with the
   * config's own enabled/disabled verdict. Returns an empty list when
   * the file is missing or holds no such block; malformed JSON throws
   * an `OhMyPiSourceError` (a broken config file is worth a loud error
   * item, not a silent zero).
   */
  readMcpServers(): OhMyPiMcpServer[] {
    const path = this.mcpConfigPath();
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new OhMyPiSourceError(`failed to parse ${path}: ${message}`);
    }
    if (!parsed || typeof parsed !== "object") return [];
    const config = parsed as Record<string, unknown>;
    const servers = config.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return [];
    }
    const denied = stringList(config.disabledServers);
    const forcedOn = stringList(config.enabledServers);
    const result: OhMyPiMcpServer[] = [];
    for (const [name, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const disabled =
        denied.includes(name) ||
        (entry.enabled === false && !forcedOn.includes(name));
      result.push({ name, raw: entry, disabled });
    }
    return result;
  }
}

function stringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}
