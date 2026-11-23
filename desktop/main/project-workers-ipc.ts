/**
 * ATO-1173 — the window's routes for worker chats (renderer/project-workers.js):
 *
 *   projects:startWorkers  {coordinatorSid, projectId, tasks}: a copy of the
 *                          project folder per task (project-workers.ts), a new
 *                          chat per copy, filed in the project, and its first
 *                          turn started at once
 *   projects:workers       the groups on record (project-workers-store.ts)
 *
 * and two events: projects:workersStarted (the new turns, shaped like
 * agent:liveTurns, so the window takes them over as turns running in chats
 * it is not showing) and projects:workersChanged (a worker ended; once the
 * last of a group has, it carries the coordinator's report).
 *
 * Main starts the turns itself (main.ts startTurn, with the copy as the
 * folder the new chat works in) so the workers do not depend on the window
 * staying open. A worker's turn runs on the project's own cloud model when it
 * has one: that pick is kept by folder (project-model.ts), and the copy is
 * another folder, so it is read here from the project's folder.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { promisify } from "node:util";

import { ipcMain } from "electron";

import { newChatSessionId } from "./chat-session.js";
import { folderKey, readProjectModels, turnModelFor, type ProjectModelPick } from "./project-model.js";
import { makeWorkerDir, planWorkers, replySummary, workerKey, workerPrompt, type Exec } from "./project-workers.js";
import {
  addGroup, emptyReply, endWorker, groupEnded, groupReport, listedWorkers, newGroupId, readWorkers, replyStep,
  writeWorkers, type ReplyState, type Worker, type WorkerGroup,
} from "./project-workers-store.js";
import { assignChat, readProjects, updateProjects } from "./projects-store.js";

type StartTurn = (
  turnId: string,
  clean: Array<{ role: string; content: string }>,
  sessionId: string | undefined,
  queuedAt: number,
  listed: boolean,
  projectId?: unknown,
  reasoning?: undefined,
  turnModel?: ProjectModelPick | null,
  workDir?: string,
) => Promise<{ ok: true; turnId: string } | { ok: false; error: string }>;

export interface WorkersDeps {
  stateDir: string;
  userData: string;
  startTurn: StartTurn;
  isRemote: () => boolean;
  /** The configured providers, for the project's own model (readWholeConfig). */
  providers: () => Promise<ReadonlyArray<{ id: string; kind: string; baseUrl?: string; url?: string }> | undefined>;
  /** Every frame of every turn (client.on("chat")). */
  onChat: (cb: (ev: { turnId?: unknown; kind?: unknown; text?: unknown; payload?: unknown }) => void) => void;
  /** A frame for a turn, as the agent client sends them (client.emit("chat")). */
  emitChat: (ev: Record<string, unknown>) => void;
  send: (channel: string, payload?: unknown) => void;
  exec?: Exec;
}

const execFileP = promisify(execFile);
/** execFile never runs a shell; output is capped so a chatty git cannot fill memory. */
const realExec: Exec = async (file, args, opts) => {
  const { stdout, stderr } = await execFileP(file, args, { cwd: opts?.cwd, timeout: opts?.timeout ?? 60000, maxBuffer: 1024 * 1024, windowsHide: true });
  return { stdout: String(stdout), stderr: String(stderr) };
};

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function wireProjectWorkersIpc(deps: WorkersDeps): void {
  const exec = deps.exec ?? realExec;
  /** turnId → the worker's chat and its reply so far, for this run of the app. */
  const turns = new Map<string, { sid: string; reply: ReplyState }>();
  const liveSid = (sid: string) => [...turns.values()].some((t) => t.sid === sid);
  let starting = false;

  deps.onChat((ev) => {
    const t = typeof ev?.turnId === "string" ? turns.get(ev.turnId) : undefined;
    if (!t) return;
    const status = replyStep(t.reply, ev);
    if (!status) return;
    turns.delete(ev.turnId as string);
    const ended = endWorker(readWorkers(deps.stateDir), t.sid, status, replySummary(t.reply.last));
    if (!ended) return;
    writeWorkers(deps.stateDir, ended.data);
    const done = groupEnded(ended.group);
    deps.send("projects:workersChanged", { group: ended.group, ...(done ? { report: groupReport(ended.group) } : {}) });
  });

  ipcMain.handle("projects:workers", () => {
    const data = listedWorkers(readWorkers(deps.stateDir), liveSid);
    // An ended group carries its report, so a window opened later can still put it in the coordinator's box.
    return { ok: true, data: { ...data, groups: data.groups.map((g) => (groupEnded(g) ? { ...g, report: groupReport(g) } : g)) } };
  });

  ipcMain.handle("projects:startWorkers", async (_event, payload: unknown) => {
    const { coordinatorSid, projectId, tasks } = (payload ?? {}) as { coordinatorSid?: unknown; projectId?: unknown; tasks?: unknown };
    if (typeof coordinatorSid !== "string" || !coordinatorSid || coordinatorSid.length > 512) return { ok: false, error: "Open the chat to split first" };
    if (deps.isRemote()) return { ok: false, error: "Worker chats need the agent on this computer: their copies are made here" };
    if (typeof projectId !== "string" || projectId.startsWith("f")) return { ok: false, error: "Worker chats need a project with a folder on disk" };
    const project = readProjects(deps.stateDir).projects.find((p) => p.id === projectId);
    if (!project) return { ok: false, error: "No such project" };
    if (!isDir(project.folder)) return { ok: false, error: "The project folder is not there" };
    const plan = planWorkers(tasks);
    if (!plan.ok) return plan;
    const busy = readWorkers(deps.stateDir).groups.some((g) => g.coordinatorSid === coordinatorSid && g.workers.some((w) => w.status === "working" && liveSid(w.sid)));
    if (busy || starting) return { ok: false, error: "This chat's workers are still running" };
    starting = true;
    try {
      const pick = readProjectModels(deps.userData)[folderKey(project.folder)];
      const turnModel = pick ? turnModelFor(pick, await deps.providers().catch(() => undefined)) : null;
      const createdAt = Date.now();
      const workers: Worker[] = [];
      for (let i = 0; i < plan.tasks.length; i++) {
        const made = await makeWorkerDir(project.folder, deps.stateDir, workerKey(project.id, createdAt, i + 1), exec);
        // The copies made so far stay on disk (nothing is removed by itself); the person is told where.
        if (!made.ok) {
          const kept = workers.length ? ` (${workers.length} cop${workers.length === 1 ? "y was" : "ies were"} made in ${workers.map((w) => w.root).join(", ")})` : "";
          return { ok: false, error: `Worker ${i + 1}: ${made.error}${kept}` };
        }
        workers.push({ sid: newChatSessionId(), dir: made.dir, root: made.root, kind: made.kind, task: plan.tasks[i]!, status: "working", summary: "", endedAt: 0 });
      }
      // Filed in the project before the first turn, so its chats list shows them from the start (startTurn's own rule).
      for (const w of workers) updateProjects(deps.stateDir, (d) => assignChat(d, w.sid, project.id));
      deps.send("projects:changed");
      const group: WorkerGroup = { id: newGroupId(), coordinatorSid, projectId: project.id, createdAt, workers };
      if (!writeWorkers(deps.stateDir, addGroup(readWorkers(deps.stateDir), group))) return { ok: false, error: "Could not save the worker chats" };

      const started = workers.map((w) => {
        const turnId = randomUUID();
        turns.set(turnId, { sid: w.sid, reply: emptyReply() });
        return { turnId, sessionId: w.sid, text: workerPrompt(w.task), startedAt: Date.now(), firstTurn: true, task: w.task, dir: w.dir };
      });
      // Before the turns start: the window must know them before their first frame comes in.
      deps.send("projects:workersStarted", { group, turns: started });
      for (const t of started) {
        const res = await deps.startTurn(t.turnId, [{ role: "user", content: t.text }], t.sessionId, Date.now(), false, project.id, undefined, turnModel, t.dir);
        if (!res.ok) deps.emitChat({ turnId: t.turnId, kind: "error", error: res.error });
      }
      return { ok: true, group, turns: started };
    } finally {
      starting = false;
    }
  });
}
