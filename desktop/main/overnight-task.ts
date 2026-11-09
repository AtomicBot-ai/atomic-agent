/**
 * ATO-1113 (desktop half): "Run overnight". What the window's dialog sends,
 * checked and turned into the agent's `POST /api/tasks` body. Pure: no
 * Electron, no network, so test/overnight-task.test.mjs reads it from `out/`.
 *
 * The body opens a new session in the chosen folder (`workingDir`, the route
 * reads it the way a new chat reads `working_dir`), asks for the Telegram
 * report when the person ticked it, and carries the run's limits as
 * `maxCostUsd` / `maxDurationMs`, the names of the group 1 contract
 * (`TaskRecord.maxCostUsd`, `TaskRecord.maxDurationMs`). An agent that does
 * not know the limits yet ignores them; the window then stops the run itself
 * when the time is up (renderer/overnight.js).
 *
 * On a remote agent the folder is the agent's own (`GET /health`): a folder
 * from this computer's picker does not exist there, and the agent refuses it.
 */

import { isAbsolute } from "node:path";

/** Same bound as the agent's TASK_USER_MESSAGE_MAX_LENGTH (src/tasks/task-types.ts). */
export const OVERNIGHT_MESSAGE_MAX = 16_000;
/** The time limit the dialog accepts, in hours. */
export const OVERNIGHT_HOURS_MIN = 0.5;
export const OVERNIGHT_HOURS_MAX = 24;
const HOUR_MS = 60 * 60 * 1000;
/**
 * The run's step ceiling, the default of the agent's `agent.task.maxSteps`.
 * A task row without `maxSteps` runs with `agent.maxSteps` (25) as its whole
 * ceiling (task-runner passes it to runTurn as `taskMaxSteps`), which would
 * end an overnight run after a few minutes.
 */
export const OVERNIGHT_MAX_STEPS = 1000;

export interface OvernightRequest {
  message: string;
  folder: string;
  /** Dollars; null or 0 = no cap. */
  maxCostUsd: number | null;
  hours: number;
  notifyTelegram: boolean;
}

export interface OvernightTaskBody {
  userMessage: string;
  workingDir: string;
  maxCostUsd: number | null;
  maxDurationMs: number;
  maxSteps: number;
  notify?: "telegram";
}

export type OvernightCheck =
  | { ok: true; request: OvernightRequest; body: OvernightTaskBody }
  | { ok: false; error: string };

/** The folder a remote agent reports in `GET /health`, or null when it does not say. */
export function remoteAgentFolder(health: unknown): string | null {
  const dir = (health as { workingDir?: unknown } | null | undefined)?.workingDir;
  return typeof dir === "string" && dir.trim() ? dir.trim() : null;
}

/** An agent whose `POST /api/tasks` still needs a `sessionId` answers with this 400. */
const NO_WORKING_DIR_ROUTE = /sessionId and userMessage are required/;

/** The agent's refusal as the dialog says it. */
export function overnightErrorText(message: string, remote: boolean): string {
  return remote && NO_WORKING_DIR_ROUTE.test(message)
    ? "This agent build cannot take Run overnight from another computer."
    : message;
}

/**
 * The dialog's input, checked. Every refusal is a sentence the dialog shows as is.
 * With `remoteFolder` (a remote agent's own folder) the dialog's folder is ignored,
 * and the path is not judged by this computer's rules: it belongs to the other one.
 */
export function overnightTaskBody(input: unknown, remoteFolder?: string): OvernightCheck {
  const raw = (input ?? {}) as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) return { ok: false, error: "Write what the agent should do." };
  if (message.length > OVERNIGHT_MESSAGE_MAX) return { ok: false, error: "The task is too long. Keep it under 16,000 characters." };
  const folder = remoteFolder ?? (typeof raw.folder === "string" ? raw.folder.trim() : "");
  if (remoteFolder === undefined && (!folder || !isAbsolute(folder))) return { ok: false, error: "Choose a folder for the agent to work in." };
  const hours = typeof raw.hours === "number" ? raw.hours : Number(raw.hours);
  if (!Number.isFinite(hours) || hours < OVERNIGHT_HOURS_MIN || hours > OVERNIGHT_HOURS_MAX) {
    return { ok: false, error: `Set a time limit from ${OVERNIGHT_HOURS_MIN} to ${OVERNIGHT_HOURS_MAX} hours.` };
  }
  let maxCostUsd: number | null = null;
  const budget = raw.maxCostUsd;
  if (budget !== null && budget !== undefined && budget !== "") {
    const n = typeof budget === "number" ? budget : Number(budget);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "The budget must be a number of dollars, or empty for no cap." };
    // 0 means no cap, as `agent.task.maxCostUsd` = 0 does.
    maxCostUsd = n > 0 ? Math.round(n * 100) / 100 : null;
  }
  const notifyTelegram = raw.notifyTelegram === true;
  const request: OvernightRequest = { message, folder, maxCostUsd, hours, notifyTelegram };
  const body: OvernightTaskBody = {
    userMessage: message,
    workingDir: folder,
    maxCostUsd,
    maxDurationMs: Math.round(hours * HOUR_MS),
    maxSteps: OVERNIGHT_MAX_STEPS,
    ...(notifyTelegram ? { notify: "telegram" as const } : {}),
  };
  return { ok: true, request, body };
}
