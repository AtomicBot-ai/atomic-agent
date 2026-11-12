/*
 * ATO-42: projects, a group of chats with one work folder and the person's
 * own instructions that every chat in the project follows (the idea is
 * Jan's: a project is a folder of threads with a name and instructions).
 *
 * Kept like the chat folders (chat-folders.ts): in the agent's state
 * directory (~/.atomic-agent/projects.json), which the terminal shares
 * since ATO-416, written whole via a temp file. Main owns the edits here
 * (projects:save|delete|assign); the renderer (the sidebar, ATO-1146) asks
 * and redraws on `projects:changed`.
 *
 * Shape (version 1):
 *   projects: [{id, name, folder, instructions, createdAt}]   newest first
 *   chats:    {sessionId: projectId}   a chat is in at most one project;
 *             no key = in no project
 *
 * Deleting a project takes its chats out of it and never deletes a chat.
 * What a turn gets from its project (turnProject) is the folder a NEW chat
 * opens in and the instructions the agent folds into its prompt (core
 * `project_instructions`, src/session/session-project.ts).
 *
 * Not here yet (separate issues, e.g. ATO-1148): per-project skills, MCP
 * servers, memory and model.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, posix, win32 } from "node:path";

export interface Project { id: string; name: string; folder: string; instructions: string; createdAt: number }
export interface Projects { version: 1; projects: Project[]; chats: Record<string, string> }
export type ProjectsResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export const MAX_PROJECTS = 500;
const MAX_CHATS = 20000;
export const MAX_PROJECT_NAME = 80;
/** The same cap the agent takes (`PROJECT_INSTRUCTIONS_MAX_CHARS`); longer text is refused, not cut. */
export const MAX_PROJECT_INSTRUCTIONS = 16000;
const MAX_PATH = 4096;
const MAX_SESSION_ID = 512;
/** Fits the sidebar's `/^[\w.:-]{1,80}$/` (ids go into data attributes). */
const ID_RE = /^p[a-z0-9]{6,24}$/;

export function projectsPath(stateDir: string): string {
  return join(stateDir, "projects.json");
}

export function emptyProjects(): Projects {
  return { version: 1, projects: [], chats: {} };
}

export function newProjectId(): string {
  return `p${randomBytes(8).toString("hex").slice(0, 12)}`;
}

function isAbsolutePath(p: string): boolean {
  return posix.isAbsolute(p) || win32.isAbsolute(p);
}

/** One line, cut by characters (an emoji is never split). */
function cleanName(name: unknown): string {
  if (typeof name !== "string") return "";
  return Array.from(name.replace(/\s+/g, " ").trim()).slice(0, MAX_PROJECT_NAME).join("");
}

function validSessionId(sid: unknown): sid is string {
  return typeof sid === "string" && sid.length > 0 && sid.length <= MAX_SESSION_ID && !/[\r\n\0]/.test(sid);
}

/** Whatever was read, as a valid value: bad entries, duplicate ids and dangling chat links dropped. */
export function coerceProjects(raw: unknown): Projects {
  const out = emptyProjects();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { projects?: unknown; chats?: unknown };
  const ids = new Set<string>();
  if (Array.isArray(r.projects)) {
    for (const p of r.projects.slice(0, MAX_PROJECTS)) {
      if (!p || typeof p !== "object") continue;
      const { id, name, folder, instructions, createdAt } = p as Record<string, unknown>;
      if (typeof id !== "string" || !ID_RE.test(id) || ids.has(id)) continue;
      const nm = cleanName(name);
      if (!nm) continue;
      if (typeof folder !== "string" || !folder || folder.length > MAX_PATH || !isAbsolutePath(folder)) continue;
      ids.add(id);
      out.projects.push({
        id, name: nm, folder,
        instructions: typeof instructions === "string" ? instructions.slice(0, MAX_PROJECT_INSTRUCTIONS) : "",
        createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0,
      });
    }
  }
  if (r.chats && typeof r.chats === "object" && !Array.isArray(r.chats)) {
    let n = 0;
    for (const [sid, pid] of Object.entries(r.chats as Record<string, unknown>)) {
      if (n >= MAX_CHATS) break;
      if (validSessionId(sid) && typeof pid === "string" && ids.has(pid)) { out.chats[sid] = pid; n++; }
    }
  }
  return out;
}

export interface ProjectInput { id?: unknown; name?: unknown; folder?: unknown; instructions?: unknown }

/**
 * Create (no id) or update (a known id) a project. Pure: returns the next
 * value and the saved project. A new project with no name is named after
 * its folder (the sidebar's "New project" picks a folder and sends
 * `{name: basename, folder}`). An update changes only the fields it sends.
 */
export function saveProject(
  data: Projects,
  input: unknown,
  now: number = Date.now(),
  makeId: () => string = newProjectId,
): ProjectsResult<{ data: Projects; project: Project }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "project required" };
  const inp = input as ProjectInput;
  const id = inp.id === undefined || inp.id === null || inp.id === "" ? null : inp.id;
  if (id !== null && typeof id !== "string") return { ok: false, error: "project id must be a string" };
  const existing = id !== null ? data.projects.find((p) => p.id === id) : undefined;
  if (id !== null && !existing) return { ok: false, error: "no such project" };

  let folder = existing?.folder ?? "";
  if (inp.folder !== undefined) {
    if (typeof inp.folder !== "string" || !inp.folder.trim()) return { ok: false, error: "project folder required" };
    const f = inp.folder.trim();
    if (f.length > MAX_PATH || !isAbsolutePath(f)) return { ok: false, error: "project folder must be an absolute path" };
    folder = f;
  }
  if (!folder) return { ok: false, error: "project folder required" };

  let name = existing?.name ?? "";
  if (inp.name !== undefined) {
    if (inp.name !== null && typeof inp.name !== "string") return { ok: false, error: "project name must be a string" };
    name = cleanName(inp.name);
  }
  if (!name) name = cleanName(basename(folder.replace(/[\\/]+$/, "")) || folder);
  if (!name) return { ok: false, error: "project name required" };

  let instructions = existing?.instructions ?? "";
  if (inp.instructions !== undefined) {
    if (inp.instructions !== null && typeof inp.instructions !== "string") return { ok: false, error: "project instructions must be a string" };
    const text = (inp.instructions ?? "").trim();
    if (text.length > MAX_PROJECT_INSTRUCTIONS) {
      return { ok: false, error: `project instructions are longer than ${MAX_PROJECT_INSTRUCTIONS} characters` };
    }
    instructions = text;
  }

  if (existing) {
    const project: Project = { ...existing, name, folder, instructions };
    return { ok: true, project, data: { ...data, projects: data.projects.map((p) => (p.id === existing.id ? project : p)) } };
  }
  if (data.projects.length >= MAX_PROJECTS) return { ok: false, error: `at most ${MAX_PROJECTS} projects` };
  let newId = makeId();
  for (let i = 0; i < 5 && (!ID_RE.test(newId) || data.projects.some((p) => p.id === newId)); i++) newId = makeId();
  if (!ID_RE.test(newId) || data.projects.some((p) => p.id === newId)) return { ok: false, error: "could not make a project id" };
  const project: Project = { id: newId, name, folder, instructions, createdAt: now };
  return { ok: true, project, data: { ...data, projects: [project, ...data.projects] } };
}

/** Remove a project; its chats leave it and are otherwise untouched. */
export function deleteProject(data: Projects, id: unknown): ProjectsResult<{ data: Projects }> {
  if (typeof id !== "string" || !data.projects.some((p) => p.id === id)) return { ok: false, error: "no such project" };
  const chats: Record<string, string> = {};
  for (const [sid, pid] of Object.entries(data.chats)) if (pid !== id) chats[sid] = pid;
  return { ok: true, data: { ...data, projects: data.projects.filter((p) => p.id !== id), chats } };
}

/** Put a chat in a project, or (projectId null) take it out of every project. */
export function assignChat(data: Projects, sessionId: unknown, projectId: unknown): ProjectsResult<{ data: Projects }> {
  if (!validSessionId(sessionId)) return { ok: false, error: "session id required" };
  const chats = { ...data.chats };
  if (projectId === null || projectId === undefined || projectId === "") {
    delete chats[sessionId];
    return { ok: true, data: { ...data, chats } };
  }
  if (typeof projectId !== "string" || !data.projects.some((p) => p.id === projectId)) return { ok: false, error: "no such project" };
  if (!(sessionId in chats) && Object.keys(chats).length >= MAX_CHATS) return { ok: false, error: "too many chats in projects" };
  chats[sessionId] = projectId;
  return { ok: true, data: { ...data, chats } };
}

export function projectForChat(data: Projects, sessionId: string | null | undefined): Project | null {
  if (!sessionId) return null;
  const pid = data.chats[sessionId];
  return pid ? data.projects.find((p) => p.id === pid) ?? null : null;
}

export interface TurnProject {
  project: Project | null;
  /** The folder a new chat opens in: the project's when it is a folder this computer can use, else the window's. */
  workingDir: string | undefined;
  /** For the agent's `project_instructions` / `project_name`: null = in no project (or no text), clear it. */
  instructions: { name: string; text: string } | null;
}

/**
 * What one turn takes from the chat's project. A stored chat is looked up
 * by its id; a chat not stored yet by the project the window asked for
 * (`projectId`), which the caller then records for the new session id.
 * `remote`: the agent runs on another computer, so no local folder is sent.
 */
export function turnProject(
  data: Projects,
  opts: { sessionId?: string | null; projectId?: unknown; windowDir: string; remote: boolean; isDir?: (dir: string) => boolean },
): TurnProject {
  const isDir = opts.isDir ?? isDirectory;
  let project = projectForChat(data, opts.sessionId ?? null);
  if (!project && !opts.sessionId && typeof opts.projectId === "string") {
    project = data.projects.find((p) => p.id === opts.projectId) ?? null;
  }
  const workingDir = opts.remote ? undefined : project && isDir(project.folder) ? project.folder : opts.windowDir;
  const instructions = project && project.instructions.trim() ? { name: project.name, text: project.instructions } : null;
  return { project, workingDir, instructions };
}

function isDirectory(dir: string): boolean {
  try { return statSync(dir).isDirectory(); } catch { return false; }
}

/** The projects on disk, or none. Never throws. */
export function readProjects(stateDir: string): Projects {
  const path = projectsPath(stateDir);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return emptyProjects(); }
  try {
    return coerceProjects(JSON.parse(text));
  } catch {
    // A file that does not parse is set aside, not overwritten by the next save: the projects in it can be recovered.
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* left as it is */ }
    return emptyProjects();
  }
}

/** Write the projects whole, via a temp file. Never throws. */
export function writeProjects(stateDir: string, value: Projects): ProjectsResult<{ data: Projects }> {
  const data = coerceProjects(value);
  const path = projectsPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read, change, write: the IPC handlers' one shape. `changed` runs only after a successful write. */
export function updateProjects<T extends { data: Projects }>(
  stateDir: string,
  change: (data: Projects) => ProjectsResult<T>,
  changed?: () => void,
): ProjectsResult<T> {
  const next = change(readProjects(stateDir));
  if (!next.ok) return next;
  const written = writeProjects(stateDir, next.data);
  if (!written.ok) return written;
  (next as { data: Projects }).data = written.data;
  changed?.();
  return next;
}

/** The chat request's project fields (core `project_instructions` / `project_name`); nothing for undefined. */
export function projectBodyFields(project: { name: string; text: string } | null | undefined): Record<string, string | null> {
  if (project === undefined) return {};
  if (project === null) return { project_instructions: null };
  return { project_instructions: project.text, project_name: project.name };
}
