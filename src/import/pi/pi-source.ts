import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  listPiFormatSessions,
  readPiFormatSession,
  type PiSessionData,
  type PiSessionMeta,
} from "./pi-session-format.js";

/**
 * Read-only access to a Pi state directory (`~/.pi/agent`). This is the
 * only file in the Pi import feature that touches its physical layout;
 * everything downstream operates on the neutral types exported here and
 * in `pi-session-format.ts` (whose listing/parsing the Oh-My-Pi source
 * reuses — the fork kept the session format).
 *
 * Layout:
 *  - `skills/…/SKILL.md`   — agent skills per the agentskills.io
 *    standard Pi implements (the same manifest family atomic-agent
 *    parses, so a skill imports as a directory copy). Pi discovers
 *    skills recursively, so grouping dirs (`skills/group/<skill>/`)
 *    are walked too. Loose root-level `*.md` skill files — a Pi
 *    extension to the standard — are not imported.
 *  - `sessions/<cwd-slug>/<timestamp>_<id>.jsonl` — session
 *    transcripts; see `pi-session-format.ts`.
 */
export interface PiSkill {
  /**
   * Path relative to the skills root, labelling the report row —
   * nested trees can carry one basename twice. The install name comes
   * from the manifest.
   */
  name: string;
  /** Absolute path to the skill's root directory. */
  dir: string;
}

export class PiSource {
  constructor(private readonly sourceDir: string) {}

  skillsDir(): string {
    return join(this.sourceDir, "skills");
  }

  sessionsDir(): string {
    return join(this.sourceDir, "sessions");
  }

  hasSkills(): boolean {
    return existsSync(this.skillsDir());
  }

  hasSessions(): boolean {
    return existsSync(this.sessionsDir());
  }

  /** Skill dirs holding a `SKILL.md`, walked recursively like Pi does. */
  listSkills(): PiSkill[] {
    return listSkillDirs(this.skillsDir(), { recursive: true });
  }

  listSessions(): PiSessionMeta[] {
    return listPiFormatSessions(this.sessionsDir());
  }

  readSession(meta: PiSessionMeta): PiSessionData {
    return readPiFormatSession(meta);
  }
}

/**
 * Collect directories holding a `SKILL.md` under `root`, sorted by
 * path. A skill dir is never descended into (its subdirs are resources,
 * not skills). Symlinked dirs count as candidates but are not walked
 * through, so a link cycle cannot loop the scan. `recursive: false`
 * scans one level — Oh-My-Pi's discovery contract.
 */
export function listSkillDirs(
  root: string,
  opts: { recursive: boolean },
): PiSkill[] {
  if (!existsSync(root)) return [];
  const skills: PiSkill[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const relName = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      const isDir = entry.isDirectory();
      if (!isDir && !(entry.isSymbolicLink() && isDirectory(child))) continue;
      if (existsSync(join(child, "SKILL.md"))) {
        skills.push({ name: relName, dir: child });
        continue;
      }
      if (opts.recursive && isDir) walk(child, relName);
    }
  };
  walk(root, "");
  skills.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return skills;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
