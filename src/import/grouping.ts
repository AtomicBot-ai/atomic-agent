import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ImportItemResult, ImportReport } from "./import-report.js";

/**
 * Keep the grouping a source had when its chats are imported (owner, W2:
 * "only flat chats were imported; keep the folders and projects").
 *
 * Every importer feeds the same hint per session: the group it belonged
 * to at the source. For the coding agents that is the folder the session
 * ran in (Claude Code's `projects/<encoded-cwd>/`, Codex's and Pi's
 * `cwd`, Hermes' and OpenClaw's `cwd` column); for the Claude app it is
 * the project a conversation was filed in. One rule turns hints into the
 * desktop's two kinds of group, the way other tools import (a ChatGPT or
 * Claude export keeps its projects; Cursor and Codex history keeps the
 * workspace):
 *
 *  - the hint names a folder that exists on this computer → a desktop
 *    Project bound to that folder (`<stateDir>/projects.json`,
 *    desktop/main/projects-store.ts), named after its last path segment,
 *    "app (parent)" when another project already has that name. A new
 *    chat in it opens there, and the session keeps its own `workingDir`,
 *    so continuing an imported chat runs in the folder it ran in.
 *  - otherwise (the folder is gone, or the group is not a folder at all)
 *    → a chat Folder of that name (`<stateDir>/chat-folders.json`,
 *    desktop/main/chat-folders.ts), remembered in its `projects` map
 *    under the hint's key, so a renamed folder keeps its chats.
 *
 * Idempotent: a project is found again by its folder path, a chat folder
 * by its key, and a chat already in place is counted, not moved. A chat
 * the person placed (put in a project, moved into or out of a folder)
 * stays where they put it. A chat the desktop's automatic sorting filed
 * (`auto` in chat-folders.json, ATO-1253) may move into its project.
 *
 * Folders the person made are never deleted and never taken over: only a
 * folder this grouping created itself (listed in `imported` in
 * chat-folders.json) is reused by name or removed when a run leaves it
 * empty. A group whose name is taken by another folder gets a folder of
 * its own, "Name (imported)".
 *
 * Sessions with no hint are not grouped here: the desktop's own sorting
 * still files them into a folder per app ("Codex", "Hermes"). The
 * desktop's "Keep chats in their projects" switch (`autoSort` in
 * chat-folders.json) turns this off along with that sorting.
 */
export interface ImportGroupHint {
  /** Stable identity of the group at the source: a folder path, or e.g. `claude-app:project:<uuid>`. */
  key: string;
  /** What the group is called; a folder's last path segment for a path. */
  name: string;
  /** The real folder the group stands for, when it is one. */
  cwd: string | null;
}

/**
 * The hint for a session that ran in `cwd`, or undefined when it recorded
 * none or the folder is not a project.
 *
 * W2 QA (803 Claude Code chats): grouping by the raw folder made 59
 * projects, most of them throwaway. So, the way Claude itself lists
 * projects:
 *   - a git worktree an agent made (`<repo>/.claude/worktrees/<name>`,
 *     `.codex/worktrees`, `.cursor/worktrees`) counts as its repository;
 *   - the home folder, the filesystem root, /tmp and the Claude
 *     app's scratch workspaces are no project: those chats stay under Chats.
 */
export function groupHintFromCwd(
  cwd: string | null | undefined,
  home: string = homedir(),
): ImportGroupHint | undefined {
  if (typeof cwd !== "string") return undefined;
  let dir = cwd.trim();
  if (!isAbsolutePath(dir)) return undefined;
  const wt = agentWorktree(dir, home);
  if (wt) {
    // The worktree's own `.git` file names its repository while it is still on disk.
    const repo = (wt.root ? repoOfWorktree(wt.root) : null) ?? wt.repoDir;
    if (repo) dir = repo;
    else {
      // Gone: the repository's name is all the path keeps (Codex, Cursor, Conductor).
      const name = wt.repoName ? cleanName(wt.repoName) : "";
      return name ? { key: `worktree-repo:${name.toLowerCase()}`, name, cwd: null } : undefined;
    }
  }
  if (!dir || !isAbsolutePath(dir) || notAProjectFolder(dir, home)) return undefined;
  const name = lastSegment(dir);
  if (!name) return undefined;
  return { key: dir, name, cwd: dir };
}

/**
 * W2 QA (16.11): a worktree an agent made, and what its path says about the
 * repository. Inside the repository (`<repo>/.claude|.codex|.cursor/worktrees/<name>`)
 * the repository is the path's head. The apps that keep them in the home
 * folder only keep the name: Codex `~/.codex/worktrees/<hash>/<repo>`,
 * Cursor `~/.cursor/worktrees/<repo>/<name>`, Conductor
 * `~/conductor/workspaces/<repo>/<name>`; Claude's `~/.claude/worktrees/<name>`
 * and `~/.claude-worktrees/<name>` keep none. `root` is the worktree folder.
 */
export function agentWorktree(
  dir: string,
  home: string = homedir(),
): { root: string | null; repoDir: string | null; repoName: string | null } | null {
  const sep = "[\\\\/]";
  const seg = "([^\\\\/]+)";
  const inTool = new RegExp(`^(.*?)${sep}\\.(claude|codex|cursor)${sep}worktrees${sep}${seg}(?:${sep}${seg})?`).exec(dir);
  if (inTool) {
    const [, base = "", tool, a = "", b] = inTool;
    const head = `${base}/.${tool}/worktrees/${a}`;
    if (!samePath(base, home)) return { root: head, repoDir: base || null, repoName: null };
    if (tool === "codex") return { root: b ? `${head}/${b}` : null, repoDir: null, repoName: b ?? null };
    if (tool === "cursor") return { root: b ? `${head}/${b}` : null, repoDir: null, repoName: a };
    return { root: head, repoDir: null, repoName: null };
  }
  const claudeApp = new RegExp(`^(.*?${sep}\\.claude-worktrees${sep}${seg})`).exec(dir);
  if (claudeApp) return { root: claudeApp[1] ?? null, repoDir: null, repoName: null };
  const conductor = new RegExp(`^(.*?${sep}conductor${sep}workspaces${sep}${seg}${sep}${seg})`).exec(dir);
  if (conductor) return { root: conductor[1] ?? null, repoDir: null, repoName: conductor[2] ?? null };
  return null;
}

/** The repository a git worktree belongs to, from its `.git` file ("gitdir: <repo>/.git/worktrees/<name>"), or null. */
function repoOfWorktree(root: string): string | null {
  try {
    const text = readFileSync(join(root, ".git"), "utf8");
    const m = /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+\s*$/m.exec(text);
    return m && m[1] ? m[1] : null;
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  return !!b && norm(a).toLowerCase() === norm(b).toLowerCase();
}

function underPath(dir: string, root: string): boolean {
  if (!root) return false;
  const d = dir.replace(/\\/g, "/").toLowerCase();
  const r = root.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  return d === r || d.startsWith(r + "/");
}

/* Only the shared /tmp: the per-user temp folder (os.tmpdir(), /var/folders
   on a Mac) also holds every test fixture, so it is not ruled out here. Where
   os.tmpdir() is /tmp itself (Linux), /tmp is that same folder and stays in. */
function notAProjectFolder(dir: string, home: string): boolean {
  if (/^(?:[a-zA-Z]:)?[\\/]*$/.test(dir)) return true;
  if (samePath(dir, home)) return true;
  for (const t of ["/tmp", "/private/tmp"]) {
    if (underPath(tmpdir(), t)) continue;
    if (underPath(dir, t)) return true;
  }
  return /[\\/]Claude[\\/]scratch-workspaces(?:[\\/]|$)/i.test(dir);
}

/** A named group that is not a folder (a Claude app project, say). */
export function namedGroupHint(
  key: string,
  name: string,
): ImportGroupHint | undefined {
  const k = key.trim();
  const n = cleanName(name);
  if (!k || !n) return undefined;
  return { key: k, name: n, cwd: null };
}

/**
 * Attach a hint to a session item, unless the session failed to import:
 * a skipped ("already matches") or conflicting session is still here and
 * is grouped too, which is what files chats imported flat before this.
 */
export function withGroupHint<T extends ImportItemResult<string>>(
  item: T,
  hint: ImportGroupHint | undefined,
): T {
  if (!hint || item.status === "error" || !item.destination) return item;
  return { ...item, group: hint };
}

// --- the two files, in the desktop's shapes (version 1) -----------------

export interface ImportProject {
  id: string;
  name: string;
  folder: string;
  instructions: string;
  createdAt: number;
}

export interface ImportProjectsFile {
  version: 1;
  projects: ImportProject[];
  /** sessionId → projectId. */
  chats: Record<string, string>;
  [extra: string]: unknown;
}

export interface ImportChatFolder {
  id: string;
  name: string;
  collapsed: boolean;
  /** W2 QA: the desktop draws a folder as a project with no disk folder; its instructions and creation time are kept. */
  instructions?: string;
  createdAt?: number;
}

export interface ImportFoldersFile {
  version: 1;
  folders: ImportChatFolder[];
  /** sessionId → folderId, or null when the person took it out of every folder. */
  chats: Record<string, string | null>;
  autoSort: boolean;
  /** folderId → the project path (or group key) the folder was made for. */
  projects: Record<string, string>;
  /** Chats the automatic sorting placed and may move again. */
  auto: Record<string, true>;
  projectSort: boolean;
  /**
   * folderId → true for folders this grouping created. The only folders
   * it may reuse by name or delete; absent when there are none.
   */
  imported?: Record<string, true>;
  [extra: string]: unknown;
}

// The desktop's own limits (projects-store.ts, chat-folders.ts).
const MAX_PROJECTS = 500;
const MAX_FOLDERS = 200;
const MAX_NAME = 80;
const PROJECT_ID_RE = /^p[a-z0-9]{6,24}$/;
const FOLDER_ID_RE = /^f[a-z0-9]{1,24}$/;
/** Folder names the desktop's sorting gives a folder per app; never bound to a project. */
const APP_FOLDER_NAMES = new Set([
  "Claude Code",
  "Codex",
  "Hermes",
  "OpenClaw",
  "Pi",
  "Oh My Pi",
  "Claude",
  "Atomic Agent",
]);

export function projectsFilePath(stateDir: string): string {
  return join(stateDir, "projects.json");
}

export function foldersFilePath(stateDir: string): string {
  return join(stateDir, "chat-folders.json");
}

export function emptyProjectsFile(): ImportProjectsFile {
  return { version: 1, projects: [], chats: {} };
}

export function emptyFoldersFile(): ImportFoldersFile {
  return {
    version: 1,
    folders: [],
    chats: {},
    autoSort: true,
    projects: {},
    auto: {},
    projectSort: true,
  };
}

/** Whatever was parsed, as a projects file: bad entries and dangling links dropped, other keys kept. */
export function coerceProjectsFile(raw: unknown): ImportProjectsFile {
  const out = emptyProjectsFile();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const ids = new Set<string>();
  if (Array.isArray(r.projects)) {
    for (const p of r.projects) {
      if (!p || typeof p !== "object") continue;
      const { id, name, folder, instructions, createdAt } = p as Record<
        string,
        unknown
      >;
      if (typeof id !== "string" || !PROJECT_ID_RE.test(id) || ids.has(id)) {
        continue;
      }
      const nm = cleanName(name);
      if (!nm || typeof folder !== "string" || !isAbsolutePath(folder)) {
        continue;
      }
      ids.add(id);
      out.projects.push({
        id,
        name: nm,
        folder,
        instructions: typeof instructions === "string" ? instructions : "",
        createdAt:
          typeof createdAt === "number" && Number.isFinite(createdAt)
            ? createdAt
            : 0,
      });
    }
  }
  if (r.chats && typeof r.chats === "object" && !Array.isArray(r.chats)) {
    for (const [sid, pid] of Object.entries(r.chats)) {
      if (sid && typeof pid === "string" && ids.has(pid)) out.chats[sid] = pid;
    }
  }
  return out;
}

/** Whatever was parsed, as a folders file (chat-folders.ts coerceChatFolders). */
export function coerceFoldersFile(raw: unknown): ImportFoldersFile {
  const out = emptyFoldersFile();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const ids = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const f of r.folders) {
      if (!f || typeof f !== "object") continue;
      const { id, name, collapsed, instructions, createdAt } = f as Record<
        string,
        unknown
      >;
      if (typeof id !== "string" || !FOLDER_ID_RE.test(id) || ids.has(id)) {
        continue;
      }
      const nm = cleanName(name);
      if (!nm) continue;
      ids.add(id);
      const folder: ImportChatFolder = {
        id,
        name: nm,
        collapsed: collapsed === true,
      };
      if (typeof instructions === "string" && instructions.trim()) {
        folder.instructions = instructions.trim().slice(0, 16000);
      }
      if (
        typeof createdAt === "number" &&
        Number.isFinite(createdAt) &&
        createdAt > 0
      ) {
        folder.createdAt = createdAt;
      }
      out.folders.push(folder);
    }
  }
  if (r.chats && typeof r.chats === "object" && !Array.isArray(r.chats)) {
    for (const [sid, fid] of Object.entries(r.chats)) {
      if (!sid) continue;
      if (fid === null) out.chats[sid] = null;
      else if (typeof fid === "string" && ids.has(fid)) out.chats[sid] = fid;
    }
  }
  out.autoSort = r.autoSort !== false;
  if (r.projects && typeof r.projects === "object" && !Array.isArray(r.projects)) {
    for (const [fid, dir] of Object.entries(r.projects)) {
      if (ids.has(fid) && typeof dir === "string" && dir) out.projects[fid] = dir;
    }
  }
  if (r.auto && typeof r.auto === "object" && !Array.isArray(r.auto)) {
    for (const [sid, on] of Object.entries(r.auto)) {
      if (on === true && typeof out.chats[sid] === "string") out.auto[sid] = true;
    }
  }
  out.projectSort = r.projectSort === true;
  if (r.imported && typeof r.imported === "object" && !Array.isArray(r.imported)) {
    const imported: Record<string, true> = {};
    for (const [fid, on] of Object.entries(r.imported)) {
      if (on === true && ids.has(fid)) imported[fid] = true;
    }
    if (Object.keys(imported).length > 0) out.imported = imported;
  }
  return out;
}

/** A folder this grouping created (never one the person or the desktop made). */
function importCreated(folders: ImportFoldersFile, fid: string): boolean {
  return folders.imported?.[fid] === true;
}

export class ImportGroupingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportGroupingError";
  }
}

/**
 * Read one of the two files. Missing → empty. A file that does not parse
 * throws: grouping is skipped rather than writing over something the
 * desktop would set aside and let the person recover.
 */
function readJsonFile<T>(path: string, coerce: (raw: unknown) => T, empty: () => T): T {
  if (!existsSync(path)) return empty();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ImportGroupingError(`cannot read ${path}: ${errorMessage(err)}`);
  }
  try {
    return coerce(JSON.parse(text));
  } catch (err) {
    throw new ImportGroupingError(`cannot parse ${path}: ${errorMessage(err)}`);
  }
}

export function readProjectsFile(stateDir: string): ImportProjectsFile {
  return readJsonFile(projectsFilePath(stateDir), coerceProjectsFile, emptyProjectsFile);
}

export function readFoldersFile(stateDir: string): ImportFoldersFile {
  return readJsonFile(foldersFilePath(stateDir), coerceFoldersFile, emptyFoldersFile);
}

/** Whole-file write through a temp file, owner-only, as the desktop writes them. */
export function writeGroupingFile(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

// --- the plan -------------------------------------------------------------

export interface ImportGroupOutcome {
  kind: "project" | "folder";
  name: string;
  /** The project's folder, or the folder's group key when it is a path; null otherwise. */
  path: string | null;
  /** Made by this run. */
  created: boolean;
  /** Chats of this group in the run. */
  chats: number;
  /** Chats this run put into the group. */
  added: number;
  /** Chats left where the person had put them. */
  kept: number;
  /** Why the group could not be made, if it could not. */
  error?: string;
}

export interface ImportGroupingEntry {
  /** "" for a group that should exist with no chat of this run in it. */
  sessionId: string;
  group: ImportGroupHint;
}

export interface PlanImportGroupingInput {
  entries: readonly ImportGroupingEntry[];
  projects: ImportProjectsFile;
  folders: ImportFoldersFile;
  isDir?: (dir: string) => boolean;
  now?: number;
  newProjectId?: () => string;
  newFolderId?: () => string;
}

export interface ImportGroupingPlan {
  projects: ImportProjectsFile;
  folders: ImportFoldersFile;
  outcomes: ImportGroupOutcome[];
  projectsChanged: boolean;
  foldersChanged: boolean;
  /** Set when nothing was grouped on purpose (the desktop's switch is off). */
  off?: string;
}

/** Pure: what the two files become, and one outcome per group. Inputs are not mutated. */
export function planImportGrouping(
  input: PlanImportGroupingInput,
): ImportGroupingPlan {
  const projects: ImportProjectsFile = clone(input.projects);
  const folders: ImportFoldersFile = clone(input.folders);
  const plan: ImportGroupingPlan = {
    projects,
    folders,
    outcomes: [],
    projectsChanged: false,
    foldersChanged: false,
  };
  if (!folders.autoSort) {
    plan.off = "Keep chats in their projects is off in Settings > Import";
    return plan;
  }
  const isDir = input.isDir ?? isDirectory;
  const now = input.now ?? Date.now();
  const makeProjectId = input.newProjectId ?? newProjectId;
  const makeFolderId = input.newFolderId ?? newFolderId;

  // One group per key, in first-seen order; a session counted once.
  const groups = new Map<string, { hint: ImportGroupHint; sessions: string[] }>();
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (entry.sessionId && seen.has(entry.sessionId)) continue;
    const key = groupKeyOf(entry.group);
    let g = groups.get(key);
    if (!g) {
      g = { hint: entry.group, sessions: [] };
      groups.set(key, g);
    }
    // An entry with no session only asks for the group to exist.
    if (!entry.sessionId) continue;
    seen.add(entry.sessionId);
    g.sessions.push(entry.sessionId);
  }

  /** Folders a chat left in this run; an import-created one is dropped if left empty. */
  const vacated = new Set<string>();

  for (const { hint, sessions } of groups.values()) {
    const asProject = hint.cwd !== null && isDir(hint.cwd);
    const outcome: ImportGroupOutcome = {
      kind: asProject ? "project" : "folder",
      name: hint.name,
      path: hint.cwd,
      created: false,
      chats: sessions.length,
      added: 0,
      kept: 0,
    };
    plan.outcomes.push(outcome);

    if (asProject) {
      const dir = hint.cwd!;
      let project = projects.projects.find(
        (p) => pathKey(p.folder) === pathKey(dir),
      );
      if (!project) {
        if (projects.projects.length >= MAX_PROJECTS) {
          outcome.error = `at most ${MAX_PROJECTS} projects`;
          continue;
        }
        const id = freshId(makeProjectId, PROJECT_ID_RE, (x) =>
          projects.projects.some((p) => p.id === x),
        );
        if (!id) {
          outcome.error = "could not make a project id";
          continue;
        }
        project = {
          id,
          name: freeName(
            projects.projects.map((p) => p.name),
            disambiguated(hint.name, dir, projects.projects.map((p) => p.name)),
          ),
          folder: dir,
          instructions: "",
          createdAt: now,
        };
        // The store lists newest first.
        projects.projects.unshift(project);
        outcome.created = true;
        plan.projectsChanged = true;
      }
      outcome.name = project.name;
      for (const sid of sessions) {
        if (projects.chats[sid] !== undefined) {
          if (projects.chats[sid] !== project.id) outcome.kept += 1;
          continue;
        }
        if (placedByPerson(folders, sid)) {
          outcome.kept += 1;
          continue;
        }
        const was = folders.chats[sid];
        if (typeof was === "string") vacated.add(was);
        projects.chats[sid] = project.id;
        // Out of every folder, and off the automatic sorting's list, so
        // the desktop's per-app sorting never files it back into one: a
        // chat in a folder is drawn under the folder, not its project.
        folders.chats[sid] = null;
        delete folders.auto[sid];
        outcome.added += 1;
        plan.projectsChanged = true;
        plan.foldersChanged = true;
      }
      continue;
    }

    let folder = findFolderForKey(folders, hint);
    // W2 QA: no new folder for a group whose chats all stay where they are
    // (in a project from an earlier run, or placed by the person).
    if (!folder && sessions.length > 0 && sessions.every((sid) => projects.chats[sid] !== undefined || placedByPerson(folders, sid))) {
      outcome.kept += sessions.length;
      continue;
    }
    if (!folder) {
      // Only a folder this grouping made itself is taken over by name: a
      // folder of the person's own is never bound to a group key, or the
      // desktop's sorting could file chats into it and a later run empty
      // and delete it.
      const named = folders.folders.find(
        (f) =>
          f.name.toLowerCase() === hint.name.toLowerCase() &&
          importCreated(folders, f.id) &&
          !(f.id in folders.projects) &&
          !APP_FOLDER_NAMES.has(f.name),
      );
      if (named) {
        folder = named;
        folders.projects[named.id] = hint.key;
        plan.foldersChanged = true;
      } else {
        if (folders.folders.length >= MAX_FOLDERS) {
          outcome.error = `at most ${MAX_FOLDERS} folders`;
          continue;
        }
        const id = freshId(makeFolderId, FOLDER_ID_RE, (x) =>
          folders.folders.some((f) => f.id === x),
        );
        if (!id) {
          outcome.error = "could not make a folder id";
          continue;
        }
        const names = folders.folders.map((f) => f.name);
        const taken = names.some((n) => n.toLowerCase() === hint.name.toLowerCase());
        folder = {
          id,
          name: freeName(
            names,
            hint.cwd !== null
              ? disambiguated(hint.name, hint.cwd, names)
              : taken
                ? cleanName(`${hint.name} (imported)`)
                : hint.name,
          ),
          collapsed: false,
        };
        folders.folders.push(folder);
        folders.projects[folder.id] = hint.key;
        (folders.imported ??= {})[folder.id] = true;
        outcome.created = true;
        plan.foldersChanged = true;
      }
    }
    outcome.name = folder.name;
    for (const sid of sessions) {
      if (projects.chats[sid] !== undefined) {
        outcome.kept += 1;
        continue;
      }
      if (folders.chats[sid] === folder.id) continue;
      if (placedByPerson(folders, sid)) {
        outcome.kept += 1;
        continue;
      }
      const was = folders.chats[sid];
      if (typeof was === "string") vacated.add(was);
      folders.chats[sid] = folder.id;
      // Placed by the import, not by the sorting: the per-app sorting
      // would otherwise move it on into "Codex" or "Hermes".
      delete folders.auto[sid];
      outcome.added += 1;
      plan.foldersChanged = true;
    }
  }

  // A folder this grouping created that this run emptied goes. Any other
  // folder stays, empty or not: it may be the person's own, and the
  // desktop's sorting may have filed chats into it as automatic.
  for (const fid of vacated) {
    if (!importCreated(folders, fid)) continue;
    if (Object.values(folders.chats).includes(fid)) continue;
    folders.folders = folders.folders.filter((f) => f.id !== fid);
    delete folders.projects[fid];
    delete folders.imported![fid];
    if (Object.keys(folders.imported!).length === 0) delete folders.imported;
    plan.foldersChanged = true;
  }
  return plan;
}

/** The person's own placement: in the chats map and not marked as the sorting's. */
function placedByPerson(folders: ImportFoldersFile, sid: string): boolean {
  return sid in folders.chats && folders.auto[sid] !== true;
}

function findFolderForKey(
  folders: ImportFoldersFile,
  hint: ImportGroupHint,
): ImportChatFolder | undefined {
  const want = hint.cwd !== null ? pathKey(hint.key) : hint.key;
  for (const [fid, key] of Object.entries(folders.projects)) {
    const have = hint.cwd !== null ? pathKey(key) : key;
    if (have !== want) continue;
    const f = folders.folders.find((x) => x.id === fid);
    if (f) return f;
  }
  return undefined;
}

function groupKeyOf(hint: ImportGroupHint): string {
  return hint.cwd !== null ? `dir:${pathKey(hint.key)}` : `key:${hint.key}`;
}

// --- running it after an import ---------------------------------------------

export interface GroupImportReportOptions {
  stateDir: string;
  /** Write the files (false in a preview: the outcomes say what would happen). */
  execute: boolean;
  isDir?: (dir: string) => boolean;
  now?: number;
}

/**
 * The step every import runs after its sessions: collect the hints the
 * session items carry, plan, write when executing, and append one
 * `projects` / `folders` item per group to the report so the CLI, the
 * TUI and the desktop all show where the chats went. A preview plans the
 * same thing without writing. Returns the report it was given, with the
 * items appended and the summary recounted.
 */
export function groupImportReport<R extends ImportReport<string>>(
  report: R,
  options: GroupImportReportOptions,
): R {
  const entries: ImportGroupingEntry[] = [];
  for (const item of report.items) {
    if (item.kind !== "sessions" || !item.group || !item.destination) continue;
    if (item.status === "error") continue;
    entries.push({ sessionId: item.destination, group: item.group });
  }
  for (const hint of report.groupHints ?? []) {
    entries.push({ sessionId: "", group: hint });
  }
  if (entries.length === 0) return report;
  const extra: ImportItemResult<string>[] = [];
  let plan: ImportGroupingPlan;
  try {
    plan = planImportGrouping({
      entries,
      projects: readProjectsFile(options.stateDir),
      folders: readFoldersFile(options.stateDir),
      ...(options.isDir ? { isDir: options.isDir } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  } catch (err) {
    extra.push({ kind: "folders", status: "error", reason: errorMessage(err) });
    return appendItems(report, extra);
  }
  if (plan.off) {
    extra.push({ kind: "folders", status: "skipped", reason: plan.off });
    return appendItems(report, extra);
  }
  let writeError: string | null = null;
  if (options.execute) {
    try {
      if (plan.projectsChanged) {
        writeGroupingFile(projectsFilePath(options.stateDir), plan.projects);
      }
      if (plan.foldersChanged) {
        writeGroupingFile(foldersFilePath(options.stateDir), plan.folders);
      }
    } catch (err) {
      writeError = errorMessage(err);
    }
  }
  for (const o of plan.outcomes) extra.push(outcomeItem(o, writeError));
  return appendItems(report, extra);
}

/**
 * One group as a report row: `[projects] migrated app -> /Users/me/app
 * (new project; 12 chats; 12 added)`. The reason's words are what the
 * desktop reads back (parseGroupReason), so keep them stable.
 */
export function outcomeItem(
  o: ImportGroupOutcome,
  writeError: string | null = null,
): ImportItemResult<string> {
  const kind = o.kind === "project" ? "projects" : "folders";
  const parts = [
    `${o.created ? "new" : "existing"} ${o.kind}`,
    `${o.chats} ${o.chats === 1 ? "chat" : "chats"}`,
  ];
  if (o.added > 0) parts.push(`${o.added} added`);
  if (o.kept > 0) parts.push(`${o.kept} kept where you put them`);
  const changes = o.created || o.added > 0;
  const status = o.error || writeError ? "error" : changes ? "migrated" : "skipped";
  if (o.error) parts.push(o.error);
  else if (writeError) parts.push(`not saved: ${writeError}`);
  else if (!changes) parts.push("already in place");
  return {
    kind,
    source: o.name,
    ...(o.path !== null ? { destination: o.path } : {}),
    status,
    reason: parts.join("; "),
  };
}

function appendItems<R extends ImportReport<string>>(
  report: R,
  extra: ImportItemResult<string>[],
): R {
  if (extra.length === 0) return report;
  const items = [...report.items, ...extra];
  const summary = { migrated: 0, skipped: 0, conflict: 0, error: 0 };
  for (const item of items) summary[item.status] += 1;
  // The group rows' kinds (`projects`, `folders`) are outside the
  // source's own option union; the report is otherwise the same object.
  return { ...report, items, summary } as R;
}

// --- small helpers ----------------------------------------------------------

/** A folder path as a comparable key (chat-list.js projectPathKey). */
export function pathKey(dir: string): string {
  let s = String(dir).trim().replace(/[\\/]+/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return /^[a-z]:(\/|$)/i.test(s) ? s.toLowerCase() : s;
}

function lastSegment(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return cleanName(parts[parts.length - 1] ?? "");
}

function parentSegment(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? (parts[parts.length - 2] ?? "") : "";
}

/** "app", or "app (client)" when another group already has the name "app". */
function disambiguated(name: string, dir: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const parent = parentSegment(dir);
  return parent ? cleanName(`${name} (${parent})`) : name;
}

/** `base`, or `base 2`, `base 3` … when that is taken too (chat-folders.js folderFreeName). */
function freeName(taken: readonly string[], base: string): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = cleanName(`${base} ${n}`);
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return Array.from(name.replace(/\s+/g, " ").trim()).slice(0, MAX_NAME).join("");
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function freshId(
  make: () => string,
  re: RegExp,
  taken: (id: string) => boolean,
): string | null {
  for (let i = 0; i < 6; i++) {
    const id = make();
    if (re.test(id) && !taken(id)) return id;
  }
  return null;
}

export function newProjectId(): string {
  return `p${randomBytes(8).toString("hex").slice(0, 12)}`;
}

export function newFolderId(): string {
  return `f${randomBytes(6).toString("hex").slice(0, 10)}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- another Atomic Agent folder's own projects and folders ------------------

export interface MergeGroupingInput {
  source: { projects: ImportProjectsFile; folders: ImportFoldersFile };
  target: { projects: ImportProjectsFile; folders: ImportFoldersFile };
  /** Chats the run brings or finds here; links for other chats are not copied. */
  sessionIds: ReadonlySet<string>;
  now?: number;
  newProjectId?: () => string;
  newFolderId?: () => string;
}

/**
 * The "Atomic Agent" source (another state dir, like a browser's "import
 * from another profile"): its projects and chat folders come over as they
 * were, not re-derived. Pure; inputs are not mutated.
 *
 *  - a project is matched by its folder path, else added (its id kept when
 *    free here), with its name and instructions.
 *  - a folder is matched by the key it was made for, else by name, else
 *    added.
 *  - a chat's link is copied only when this side has none for it: what the
 *    person arranged here wins.
 *
 * Unlike planImportGrouping this ignores the `autoSort` switch on purpose:
 * that switch turns off sorting chats into groups derived from where they
 * ran, while this copies the person's own arrangement, which they made by
 * hand and always comes over. Nothing here deletes a folder, and folders
 * made here are not marked `imported`: they are the person's, not the
 * grouping's.
 */
export function mergeGroupingFrom(input: MergeGroupingInput): ImportGroupingPlan {
  const projects = clone(input.target.projects);
  const folders = clone(input.target.folders);
  const plan: ImportGroupingPlan = {
    projects,
    folders,
    outcomes: [],
    projectsChanged: false,
    foldersChanged: false,
  };
  const now = input.now ?? Date.now();
  const makeProjectId = input.newProjectId ?? newProjectId;
  const makeFolderId = input.newFolderId ?? newFolderId;
  const src = input.source;

  for (const sp of src.projects.projects) {
    const outcome: ImportGroupOutcome = {
      kind: "project",
      name: sp.name,
      path: sp.folder,
      created: false,
      chats: 0,
      added: 0,
      kept: 0,
    };
    plan.outcomes.push(outcome);
    let tp = projects.projects.find((p) => pathKey(p.folder) === pathKey(sp.folder));
    if (!tp) {
      if (projects.projects.length >= MAX_PROJECTS) {
        outcome.error = `at most ${MAX_PROJECTS} projects`;
        continue;
      }
      const id = !projects.projects.some((p) => p.id === sp.id)
        ? sp.id
        : freshId(makeProjectId, PROJECT_ID_RE, (x) => projects.projects.some((p) => p.id === x));
      if (!id) {
        outcome.error = "could not make a project id";
        continue;
      }
      tp = {
        ...sp,
        id,
        name: freeName(projects.projects.map((p) => p.name), sp.name),
        createdAt: sp.createdAt || now,
      };
      projects.projects.push(tp);
      outcome.created = true;
      plan.projectsChanged = true;
    }
    outcome.name = tp.name;
    for (const [sid, pid] of Object.entries(src.projects.chats)) {
      if (pid !== sp.id || !input.sessionIds.has(sid)) continue;
      outcome.chats += 1;
      if (projects.chats[sid] !== undefined) {
        if (projects.chats[sid] !== tp.id) outcome.kept += 1;
        continue;
      }
      projects.chats[sid] = tp.id;
      outcome.added += 1;
      plan.projectsChanged = true;
    }
  }

  for (const sf of src.folders.folders) {
    const key = src.folders.projects[sf.id];
    const outcome: ImportGroupOutcome = {
      kind: "folder",
      name: sf.name,
      path: key !== undefined && isAbsolutePath(key) ? key : null,
      created: false,
      chats: 0,
      added: 0,
      kept: 0,
    };
    plan.outcomes.push(outcome);
    let tf: ImportChatFolder | undefined;
    if (key !== undefined) {
      const fid = Object.keys(folders.projects).find(
        (id) => folders.projects[id] === key && folders.folders.some((f) => f.id === id),
      );
      tf = fid ? folders.folders.find((f) => f.id === fid) : undefined;
    }
    tf ??= folders.folders.find((f) => f.name.toLowerCase() === sf.name.toLowerCase());
    if (!tf) {
      if (folders.folders.length >= MAX_FOLDERS) {
        outcome.error = `at most ${MAX_FOLDERS} folders`;
        continue;
      }
      const id = !folders.folders.some((f) => f.id === sf.id)
        ? sf.id
        : freshId(makeFolderId, FOLDER_ID_RE, (x) => folders.folders.some((f) => f.id === x));
      if (!id) {
        outcome.error = "could not make a folder id";
        continue;
      }
      tf = { id, name: sf.name, collapsed: sf.collapsed };
      folders.folders.push(tf);
      if (key !== undefined) folders.projects[id] = key;
      outcome.created = true;
      plan.foldersChanged = true;
    }
    outcome.name = tf.name;
    for (const [sid, fid] of Object.entries(src.folders.chats)) {
      if (fid !== sf.id || !input.sessionIds.has(sid)) continue;
      outcome.chats += 1;
      if (sid in folders.chats) {
        if (folders.chats[sid] !== tf.id) outcome.kept += 1;
        continue;
      }
      folders.chats[sid] = tf.id;
      if (src.folders.auto[sid] === true) folders.auto[sid] = true;
      outcome.added += 1;
      plan.foldersChanged = true;
    }
  }
  // "Taken out of every folder" over there stays so here, for chats new here.
  for (const [sid, fid] of Object.entries(src.folders.chats)) {
    if (fid !== null || !input.sessionIds.has(sid) || sid in folders.chats) continue;
    folders.chats[sid] = null;
    plan.foldersChanged = true;
  }
  return plan;
}
