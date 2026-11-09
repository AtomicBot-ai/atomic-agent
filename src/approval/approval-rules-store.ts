import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import { writeOwnerOnlyFileAtomicSync } from "../config/owner-only-file.js";
import {
  APPROVAL_RULES_FILE_VERSION,
  ApprovalRulesFormatError,
  parseApprovalRule,
  parseApprovalRulesFile,
  sameRuleScope,
  type ApprovalRule,
  type ApprovalRulesFile,
  type ApprovalRulesOrigin,
  type NewApprovalRule,
} from "./approval-rules.js";

/** File name of the global rules file, next to `config.json` in the state dir. */
export const APPROVAL_RULES_FILE_NAME = "approval-rules.json";

/** Folder inside a project that holds its rules file. */
export const PROJECT_RULES_DIR_NAME = ".atomic-agent";

export function getApprovalRulesPath(stateDir: string): string {
  return join(stateDir, APPROVAL_RULES_FILE_NAME);
}

export function getProjectApprovalRulesPath(workdir: string): string {
  return join(workdir, PROJECT_RULES_DIR_NAME, APPROVAL_RULES_FILE_NAME);
}

/**
 * What the gate needs from a rules store. `projectRules` and
 * `canonicalDir` are optional so a test can hand the gate a plain list.
 */
export interface ApprovalRulesSource {
  /** Rules of the global file. */
  list(): readonly ApprovalRule[];
  /** Save a rule in the global file; an identical rule already there is returned as is. */
  add(rule: NewApprovalRule): ApprovalRule;
  /** Remove a global rule by id; false when there is none. */
  remove(id: string): boolean;
  /** Ask / deny rules of `<workdir>/.atomic-agent/approval-rules.json`. */
  projectRules?(workdir: string): readonly ApprovalRule[];
  /** The form a working directory is matched and stored in (realpath). */
  canonicalDir?(dir: string): string;
}

export type ApprovalRulesLog = (
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface ApprovalRulesStoreOptions {
  stateDir: string;
  /** Warnings: a corrupt file, a skipped rule. Never throws. */
  warn?: ApprovalRulesLog;
  /** Test seams. */
  now?: () => Date;
  newId?: () => string;
}

interface CachedFile {
  /** `null` when the file does not exist. */
  stamp: string | null;
  rules: ApprovalRule[];
  /** The file exists but could not be read as a rules file. */
  corrupt: boolean;
}

/**
 * The rules files on disk. No watcher: each read compares the file's
 * stat (mtime, size, inode) with the last load and reloads on a change,
 * so a rule the desktop or a person writes applies to the next request.
 *
 * A missing file is an empty rule set. A file that cannot be parsed is
 * logged and treated as empty, never a crash; before the first write
 * over it, it is moved aside to `approval-rules.json.corrupt-<time>` so
 * a person's hand edit is not lost.
 */
export class ApprovalRulesStore implements ApprovalRulesSource {
  readonly globalPath: string;
  private readonly warn: ApprovalRulesLog;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly cache = new Map<string, CachedFile>();
  private readonly canonical = new Map<string, string>();

  constructor(options: ApprovalRulesStoreOptions) {
    this.globalPath = getApprovalRulesPath(options.stateDir);
    this.warn = options.warn ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `r_${randomBytes(4).toString("hex")}`);
  }

  list(): readonly ApprovalRule[] {
    return this.load(this.globalPath, "global").rules;
  }

  projectRules(workdir: string): readonly ApprovalRule[] {
    return this.load(getProjectApprovalRulesPath(workdir), "project").rules;
  }

  /** The project rules file a workdir would use, for the HTTP listing. */
  projectPath(workdir: string): string {
    return getProjectApprovalRulesPath(workdir);
  }

  canonicalDir(dir: string): string {
    const key = resolvePath(dir);
    const hit = this.canonical.get(key);
    if (hit !== undefined) return hit;
    let value = key;
    try {
      value = realpathSync(key);
    } catch {
      // A folder that does not exist (yet) is matched as written.
    }
    this.canonical.set(key, value);
    return value;
  }

  add(input: NewApprovalRule): ApprovalRule {
    const parsed = parseApprovalRule({
      ...input,
      id: this.newId(),
      createdAt: input.createdAt ?? this.now().toISOString(),
    });
    if (typeof parsed === "string") {
      throw new Error(`invalid approval rule: ${parsed}`);
    }
    const rule: ApprovalRule = {
      ...parsed,
      ...(parsed.project !== undefined
        ? { project: this.canonicalDir(parsed.project) }
        : {}),
    };
    const current = this.loadForWrite();
    const existing = current.find((r) => sameRuleScope(r, rule));
    if (existing !== undefined) return existing;
    this.write([...current, rule]);
    return rule;
  }

  remove(id: string): boolean {
    const current = this.loadForWrite();
    const next = current.filter((r) => r.id !== id);
    if (next.length === current.length) return false;
    this.write(next);
    return true;
  }

  /** The global rules as on disk now; a corrupt file is moved aside first. */
  private loadForWrite(): ApprovalRule[] {
    this.cache.delete(this.globalPath);
    const loaded = this.load(this.globalPath, "global");
    if (loaded.corrupt) {
      const aside = `${this.globalPath}.corrupt-${this.now().getTime()}`;
      try {
        renameSync(this.globalPath, aside);
        this.warn("approval rules file was unreadable; moved aside before saving", {
          path: this.globalPath,
          movedTo: aside,
        });
      } catch (err) {
        this.warn("approval rules file was unreadable and could not be moved aside", {
          path: this.globalPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return [];
    }
    return [...loaded.rules];
  }

  private write(rules: ApprovalRule[]): void {
    const file: ApprovalRulesFile = { version: APPROVAL_RULES_FILE_VERSION, rules };
    mkdirSync(dirname(this.globalPath), { recursive: true });
    writeOwnerOnlyFileAtomicSync(this.globalPath, `${JSON.stringify(file, null, 2)}\n`);
    this.cache.delete(this.globalPath);
  }

  private load(path: string, origin: ApprovalRulesOrigin): CachedFile {
    const stamp = fileStamp(path);
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.stamp === stamp) return cached;
    const fresh = this.read(path, origin, stamp);
    this.cache.set(path, fresh);
    return fresh;
  }

  private read(
    path: string,
    origin: ApprovalRulesOrigin,
    stamp: string | null,
  ): CachedFile {
    if (stamp === null) return { stamp, rules: [], corrupt: false };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      this.warn("approval rules file is not valid JSON; ignoring it", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return { stamp, rules: [], corrupt: true };
    }
    try {
      const { rules, warnings } = parseApprovalRulesFile(raw, origin);
      for (const warning of warnings) this.warn(`approval rules: ${warning}`, { path });
      return {
        stamp,
        rules: rules.map((rule) => this.canonicalRule(rule)),
        corrupt: false,
      };
    } catch (err) {
      if (!(err instanceof ApprovalRulesFormatError)) throw err;
      this.warn(`approval rules file ignored: ${err.message}`, { path });
      return { stamp, rules: [], corrupt: true };
    }
  }

  /**
   * `project` in the form a session's workdir is compared in. `path` is
   * kept as written: the paths a request names are not resolved through
   * symlinks either.
   */
  private canonicalRule(rule: ApprovalRule): ApprovalRule {
    return {
      ...rule,
      ...(rule.project !== undefined ? { project: this.canonicalDir(rule.project) } : {}),
    };
  }
}

/** A cheap change marker for a file, or null when it does not exist. */
function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}
