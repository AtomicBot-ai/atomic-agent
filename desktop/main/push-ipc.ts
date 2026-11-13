import { ipcMain } from "electron";

import { atagRun, configGetKey, plainCliError, withConfigLock, type CliResult } from "./agent-cli.js";
import { readDotenvValue } from "./composio-key.js";
import { DESKTOP_STATE_DIR } from "./state-dir.js";
import {
  isUnsupportedPushCli,
  parsePushOp,
  parsePushState,
  pushCliArgs,
  pushOpWritesConfig,
  turnPushRequest,
  type PushState,
} from "./push-cli.js";

/**
 * Settings › Connections › Phone push (ATO-1129). Two routes, both
 * through the bundled agent (push-cli.ts says why):
 *
 *   cli:pushStatus → `atag config get notifications.push`
 *   cli:pushSet    → `atag push on|off|test` (`on --new-topic` for a new topic)
 *
 * Every answer is `{ok: true, ...}` or `{ok: false, error, unsupported?}`;
 * nothing throws at the window.
 */

const UNSUPPORTED = "This agent has no phone push yet. Update Atomic Agent to set it up here.";

type Failure = { ok: false; error: string; unsupported?: boolean };

function failure(res: CliResult): Failure {
  if (isUnsupportedPushCli(`${res.stderr}\n${res.error ?? ""}`)) return { ok: false, unsupported: true, error: UNSUPPORTED };
  return { ok: false, error: plainCliError(res.stderr) || res.error || "the agent did not answer" };
}

export async function pushStatus(): Promise<{ ok: true; push: PushState } | Failure> {
  const res = await configGetKey("notifications.push");
  if (!res.ok) return { ok: false, error: res.error ?? "could not read the setting" };
  const push = parsePushState(res.value);
  return push ? { ok: true, push } : { ok: false, unsupported: true, error: UNSUPPORTED };
}

/**
 * A desktop turn ended while nobody was looking (turn-notify.ts): send the
 * same words to the phone when push is on. One attempt, 8 s, never throws.
 */
export async function pushTurnNote(
  note: { title: string; body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const st = await pushStatus();
    if (!st.ok) return false;
    const req = turnPushRequest(st.push, note, readDotenvValue(DESKTOP_STATE_DIR, st.push.tokenEnv));
    if (!req) return false;
    const res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(8_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function wirePushIpc(): void {
  ipcMain.handle("cli:pushStatus", () => pushStatus());

  ipcMain.handle("cli:pushSet", async (_event, raw: unknown) => {
    const op = parsePushOp(raw);
    if (!op) return { ok: false, error: "unknown push operation" };
    const go = () => atagRun(pushCliArgs(op), 30_000);
    const res = pushOpWritesConfig(op) ? await withConfigLock(go) : await go();
    if (!res.ok) return failure(res);
    const after = await pushStatus();
    return { ok: true, message: res.stdout.trim(), ...(after.ok ? { push: after.push } : {}) };
  });
}
