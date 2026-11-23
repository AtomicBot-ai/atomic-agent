/*
 * ATO-1173: the worker chats a coordinator chat started, kept beside the
 * projects (~/.atomic-agent/project-workers.json, the state directory the
 * terminal shares) and written whole via a temp file, like projects-store.ts.
 *
 * Shape (version 1):
 *   groups: [{id, coordinatorSid, projectId, createdAt,
 *             workers: [{sid, dir, root, kind, task, status, summary, endedAt}]}]   newest first
 *
 * status: working (its turn runs), done, failed, stopped. A worker whose turn
 * this run of the app never saw end (the app quit under it) reads as stopped.
 * The copies on disk are never removed from here.
 *
 * Also here, the bookkeeping of one worker turn's reply as its frames stream
 * by (replyStep): the text after the last tool call is the reply the worker
 * ended with, and its summary is what the coordinator gets.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

import { MAX_SUMMARY_CHARS, MAX_TASK_CHARS, MAX_WORKERS, coordinatorReport } from "./project-workers.js";

export type WorkerStatus = "working" | "done" | "failed" | "stopped";
const STATUSES: readonly WorkerStatus[] = ["working", "done", "failed", "stopped"];

export interface Worker {
  sid: string; dir: string; root: string; kind: "worktree" | "copy"; task: string;
  status: WorkerStatus; summary: string; endedAt: number;
}
export interface WorkerGroup { id: string; coordinatorSid: string; projectId: string; createdAt: number; workers: Worker[] }
export interface WorkersData { version: 1; groups: WorkerGroup[] }

const MAX_GROUPS = 200;
const MAX_PATH = 4096;
const MAX_SID = 512;

export function workersPath(stateDir: string): string {
  return join(stateDir, "project-workers.json");
}

export function emptyWorkers(): WorkersData {
  return { version: 1, groups: [] };
}

export function newGroupId(): string {
  return `g${randomBytes(6).toString("hex")}`;
}

function sidOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_SID && !/[\r\n\0]/.test(v);
}
function pathOk(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_PATH && (posix.isAbsolute(v) || win32.isAbsolute(v));
}

/** Whatever was read, as a valid value: bad groups and workers dropped, at most MAX_GROUPS kept. */
export function coerceWorkers(raw: unknown): WorkersData {
  const out = emptyWorkers();
  const groups = raw && typeof raw === "object" ? (raw as { groups?: unknown }).groups : null;
  if (!Array.isArray(groups)) return out;
  const ids = new Set<string>();
  for (const g of groups) {
    if (out.groups.length >= MAX_GROUPS) break;
    if (!g || typeof g !== "object") continue;
    const { id, coordinatorSid, projectId, createdAt, workers } = g as Record<string, unknown>;
    if (typeof id !== "string" || !/^g[a-z0-9]{4,24}$/.test(id) || ids.has(id)) continue;
    if (!sidOk(coordinatorSid) || typeof projectId !== "string" || !/^[\w.:-]{1,80}$/.test(projectId)) continue;
    const list: Worker[] = [];
    for (const w of Array.isArray(workers) ? workers.slice(0, MAX_WORKERS) : []) {
      if (!w || typeof w !== "object") continue;
      const r = w as Record<string, unknown>;
      if (!sidOk(r.sid) || !pathOk(r.dir) || typeof r.task !== "string" || !r.task.trim()) continue;
      list.push({
        sid: r.sid, dir: r.dir, root: pathOk(r.root) ? r.root : r.dir,
        kind: r.kind === "copy" ? "copy" : "worktree",
        task: r.task.slice(0, MAX_TASK_CHARS),
        status: STATUSES.includes(r.status as WorkerStatus) ? (r.status as WorkerStatus) : "stopped",
        summary: typeof r.summary === "string" ? r.summary.slice(0, MAX_SUMMARY_CHARS) : "",
        endedAt: typeof r.endedAt === "number" && Number.isFinite(r.endedAt) ? r.endedAt : 0,
      });
    }
    if (!list.length) continue;
    ids.add(id);
    out.groups.push({ id, coordinatorSid, projectId, createdAt: typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0, workers: list });
  }
  return out;
}

/** The record on disk, or none. Never throws; a file that does not parse is set aside, not overwritten. */
export function readWorkers(stateDir: string): WorkersData {
  const path = workersPath(stateDir);
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return emptyWorkers(); }
  try {
    return coerceWorkers(JSON.parse(text));
  } catch {
    try { renameSync(path, `${path}.bad-${Date.now()}`); } catch { /* left as it is */ }
    return emptyWorkers();
  }
}

export function writeWorkers(stateDir: string, value: WorkersData): boolean {
  const data = coerceWorkers(value);
  const path = workersPath(stateDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** A new group goes first; the oldest fall off past MAX_GROUPS (their copies stay on disk). */
export function addGroup(data: WorkersData, group: WorkerGroup): WorkersData {
  return { ...data, groups: [group, ...data.groups.filter((g) => g.id !== group.id)].slice(0, MAX_GROUPS) };
}

/** One worker's end. Returns the changed data and its group, or null for a worker not on record. */
export function endWorker(
  data: WorkersData, sid: string, status: WorkerStatus, summary: string, now = Date.now(),
): { data: WorkersData; group: WorkerGroup } | null {
  const i = data.groups.findIndex((g) => g.workers.some((w) => w.sid === sid));
  if (i < 0) return null;
  const g = data.groups[i]!;
  const group: WorkerGroup = {
    ...g, workers: g.workers.map((w) => (w.sid === sid ? { ...w, status, summary: summary.slice(0, MAX_SUMMARY_CHARS), endedAt: now } : w)),
  };
  const groups = data.groups.slice();
  groups[i] = group;
  return { data: { ...data, groups }, group };
}

export function groupEnded(group: WorkerGroup): boolean {
  return group.workers.every((w) => w.status !== "working");
}

/** The coordinator's report of a group (project-workers.ts coordinatorReport). */
export function groupReport(group: WorkerGroup): string {
  return coordinatorReport(group.workers);
}

/** For the window: a worker still "working" whose turn this run is not following has stopped. */
export function listedWorkers(data: WorkersData, live: (sid: string) => boolean): WorkersData {
  return {
    ...data,
    groups: data.groups.map((g) => ({
      ...g, workers: g.workers.map((w) => (w.status === "working" && !live(w.sid) ? { ...w, status: "stopped" as const } : w)),
    })),
  };
}

/* ---- one worker turn's reply, as its frames stream by ---- */

export interface ReplyState { last: string; failed: boolean }
const REPLY_KEEP = 8000;

export function emptyReply(): ReplyState {
  return { last: "", failed: false };
}

/**
 * One frame of a worker's turn. Text accumulates; a tool call starts the
 * reply over (what came before it was the model talking on its way), so
 * what is left at the end is the reply the worker ended with. A named error
 * frame marks the turn failed unless text follows it (the agent recovered).
 * Returns the end status once the turn is over, else null.
 */
export function replyStep(st: ReplyState, ev: { kind?: unknown; text?: unknown; payload?: unknown }): WorkerStatus | null {
  const kind = typeof ev.kind === "string" ? ev.kind : "";
  if (kind === "delta" && typeof ev.text === "string") {
    st.last = (st.last + ev.text).slice(-REPLY_KEEP);
    st.failed = false;
    return null;
  }
  if (kind === "tool_progress" || kind === "tool_update") { st.last = ""; return null; }
  if (kind === "error" && ev.payload) { st.failed = true; return null; }
  if (kind === "done") return st.failed ? "failed" : "done";
  if (kind === "aborted") return "stopped";
  if (kind === "error") return "failed";
  return null;
}
