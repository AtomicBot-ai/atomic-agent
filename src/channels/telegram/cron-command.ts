import {
  TaskValidationError,
  isPausedTask,
  validateSchedule,
  type TaskPauseRefusal,
  type TaskPauseResult,
  type TaskRecord,
  type TaskSchedule,
} from "../../tasks/index.js";

import { CRON_USAGE, parseCronCommand } from "./cron-command-parse.js";

/**
 * `/cron` over Telegram (ATO-21): create, list, pause, resume and delete
 * scheduled tasks from the chat. Scheduling is the core's: the command
 * only parses, validates with `validateSchedule` (the same `cron-parser`
 * path `task create --cron` goes through) and calls a `CronTaskService`
 * built on the runtime's `TaskRunner` / `TaskStore`
 * ([cron-task-service](cron-task-service.ts)). Tests pass a fake.
 */

export interface CronCreateInput {
  expression: string;
  tz?: string;
  message: string;
}

export interface CronTaskService {
  /** Recent tasks, newest first; the command keeps the scheduled ones. */
  list(): TaskRecord[];
  /** Persist a cron task that reports to Telegram. May throw `TaskValidationError`. */
  create(input: CronCreateInput): TaskRecord;
  pause(id: string): TaskPauseResult;
  resume(id: string): TaskPauseResult;
  /** Cancel the task (a run in progress is stopped); the row stays in history. */
  remove(id: string): TaskPauseResult;
  /** False when the scheduler is off, so a cron would never fire. */
  readonly schedulerRunning: boolean;
}

export interface CronCommandDeps {
  /** `null` when the runtime has no task queue. */
  service: CronTaskService | null;
  /** Telegram user id of the sender. */
  senderId: number;
  ownerUserId: number | null;
  now?: () => number;
}

const ID_PREFIX = "t-";
const SHORT_ID_CHARS = 8;
const MIN_ID_CHARS = 4;
const LIST_MAX = 20;
const MESSAGE_PREVIEW_CHARS = 80;

export function runCronCommand(rawArgs: string, deps: CronCommandDeps): string {
  // `handleInboundText` already drops non-owners; checked again because a
  // cron runs the agent unattended with the owner's tools.
  if (deps.ownerUserId === null || deps.senderId !== deps.ownerUserId) {
    return "Only the owner of this bot can manage scheduled tasks.";
  }
  const command = parseCronCommand(rawArgs);
  if (command.kind === "error") return command.message;
  if (command.kind === "help") return CRON_USAGE;
  const service = deps.service;
  if (!service) return "Scheduled tasks are not available in this agent.";
  const now = deps.now?.() ?? Date.now();
  switch (command.kind) {
    case "list":
      return formatList(service.list(), service.schedulerRunning);
    case "add":
      return create(command, service, now);
    case "pause":
    case "resume":
    case "delete":
      return changeOne(command.kind, command.id, service);
  }
}

function create(input: CronCreateInput, service: CronTaskService, now: number): string {
  const schedule: TaskSchedule = {
    kind: "cron",
    expression: input.expression,
    ...(input.tz ? { tz: input.tz } : {}),
  };
  try {
    validateSchedule(schedule, now);
  } catch (err) {
    if (err instanceof TaskValidationError) {
      return `Not scheduled: "${input.expression}" is not a valid cron (${err.message}).\nSend /cron help for the format.`;
    }
    throw err;
  }
  let task: TaskRecord;
  try {
    task = service.create(input);
  } catch (err) {
    if (err instanceof TaskValidationError) return `Not scheduled: ${err.message}.`;
    throw err;
  }
  const id = shortId(task.id);
  const lines = [
    `Scheduled ${id}: ${describeSchedule(task)}`,
    task.scheduledFor !== null ? `Next run: ${formatWhen(task.scheduledFor, input.tz)}` : null,
    "Each result comes back to your private chat with this bot.",
    `Pause: /cron pause ${id}   Delete: /cron delete ${id}`,
    service.schedulerRunning ? null : SCHEDULER_OFF,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

const SCHEDULER_OFF =
  "Note: the task scheduler is off in this agent's settings (tasks.enabled / tasks.schedulerEnabled), so nothing will run until it is on.";

function changeOne(
  kind: "pause" | "resume" | "delete",
  rawId: string,
  service: CronTaskService,
): string {
  const resolved = resolveId(rawId, scheduled(service.list()));
  if ("error" in resolved) return resolved.error;
  const result =
    kind === "pause"
      ? service.pause(resolved.id)
      : kind === "resume"
        ? service.resume(resolved.id)
        : service.remove(resolved.id);
  const id = shortId(resolved.id);
  if (!result.ok) return refusalText(result.reason, id);
  if (kind === "pause") return `Paused ${id}. It will not run until /cron resume ${id}.`;
  if (kind === "delete") return `Deleted ${id}. It will not run again.`;
  const next = result.task.scheduledFor;
  const tz = result.task.schedule?.kind === "cron" ? result.task.schedule.tz : undefined;
  return next !== null
    ? `Resumed ${id}. Next run: ${formatWhen(next, tz)}`
    : `Resumed ${id}.`;
}

function refusalText(reason: TaskPauseRefusal, id: string): string {
  switch (reason) {
    case "not_found":
      return `No scheduled task ${id}. Send /cron to see the list.`;
    case "not_recurring":
      return `${id} is not a scheduled task.`;
    case "running":
      return `${id} is running right now. Try again when this run is over.`;
    case "already_paused":
      return `${id} is already paused. /cron resume ${id} starts it again.`;
    case "not_paused":
      return `${id} is not paused.`;
    case "ended":
      return `${id} has already ended.`;
  }
}

/** Scheduled tasks that can still fire: waiting, running now, or paused. */
function scheduled(tasks: readonly TaskRecord[]): TaskRecord[] {
  return tasks.filter(
    (t) =>
      t.recurring &&
      t.schedule !== null &&
      (t.status === "pending" || t.status === "running" || t.status === "paused"),
  );
}

function formatList(tasks: readonly TaskRecord[], schedulerRunning: boolean): string {
  const rows = scheduled(tasks);
  if (rows.length === 0) {
    return "No scheduled tasks.\nAdd one: /cron add 0 9 * * * morning digest";
  }
  const shown = rows.slice(0, LIST_MAX);
  const lines = [`Scheduled tasks (${rows.length}):`];
  for (const task of shown) {
    lines.push(`${shortId(task.id)} · ${describeSchedule(task)} · ${stateOf(task)}`);
    lines.push(`  ${preview(task.userMessage)}`);
  }
  if (rows.length > shown.length) lines.push(`…and ${rows.length - shown.length} more.`);
  lines.push("", "/cron pause <id>, /cron resume <id>, /cron delete <id>");
  if (!schedulerRunning) lines.push(SCHEDULER_OFF);
  return lines.join("\n");
}

function stateOf(task: TaskRecord): string {
  if (isPausedTask(task)) return "Paused";
  if (task.status === "running") return "running now";
  const tz = task.schedule?.kind === "cron" ? task.schedule.tz : undefined;
  return task.scheduledFor !== null ? `next ${formatWhen(task.scheduledFor, tz)}` : "due now";
}

function describeSchedule(task: TaskRecord): string {
  const s = task.schedule;
  if (!s) return "once";
  if (s.kind === "cron") return s.tz ? `${s.expression} (${s.tz})` : `${s.expression} (local time)`;
  if (s.kind === "interval") return `every ${Math.round(s.everyMs / 1_000)}s`;
  return "once";
}

function preview(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > MESSAGE_PREVIEW_CHARS
    ? `${flat.slice(0, MESSAGE_PREVIEW_CHARS - 1)}…`
    : flat;
}

/** `t-1a2b3c4d-…` -> `t-1a2b3c4d`: enough to tell a handful of crons apart. */
export function shortId(id: string): string {
  if (!id.startsWith(ID_PREFIX)) return id;
  return id.slice(0, ID_PREFIX.length + SHORT_ID_CHARS);
}

/**
 * Match what the owner typed against the scheduled tasks: the full id,
 * or a unique prefix of at least `MIN_ID_CHARS` characters, with or
 * without the `t-`.
 */
export function resolveId(
  raw: string,
  tasks: readonly TaskRecord[],
): { id: string } | { error: string } {
  const typed = raw.trim().toLowerCase();
  const wanted = typed.startsWith(ID_PREFIX) ? typed : `${ID_PREFIX}${typed}`;
  const exact = tasks.find((t) => t.id.toLowerCase() === wanted);
  if (exact) return { id: exact.id };
  if (wanted.length - ID_PREFIX.length < MIN_ID_CHARS) {
    return { error: `Give at least ${MIN_ID_CHARS} characters of the id. Send /cron to see the ids.` };
  }
  const matches = tasks.filter((t) => t.id.toLowerCase().startsWith(wanted));
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return { error: `No scheduled task ${raw.trim()}. Send /cron to see the list.` };
  return {
    error: `${raw.trim()} matches ${matches.length} tasks (${matches.map((t) => shortId(t.id)).join(", ")}). Give more of the id.`,
  };
}

/** `2026-11-13 09:00 UTC`, in the schedule's zone (or this machine's). */
export function formatWhen(ms: number, tz?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      ...(tz ? { timeZone: tz } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    const get = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${get("timeZoneName")}`.trim();
  } catch {
    return new Date(ms).toISOString();
  }
}
