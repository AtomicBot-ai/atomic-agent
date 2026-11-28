import type { Key } from "ink";

import type { ApprovalRequest } from "../../approval/approval-gate.js";
import { checkShellSecretValue, SHELL_SECRET_CATEGORY } from "../../approval/shell-secret.js";
import type { TuiAction } from "../tui-action.js";

/**
 * The masked field of a `shell_secret_input` request (ATO-2486): a password
 * an interactive shell job asks for, typed by the person and sent
 * straight into the job. The value lives only in the field's own React
 * state (`secret-input-prompt.tsx`), never in `TuiState`, the composer,
 * the input history or a log line.
 */

/** Whether this request is a secret the person types (not a verdict). */
export function isShellSecretRequest(request: ApprovalRequest | null | undefined): boolean {
  return request?.category === SHELL_SECRET_CATEGORY;
}

export type SecretKeyResult =
  | { kind: "edit"; buffer: string }
  | { kind: "submit"; buffer: string }
  | { kind: "ignore" };

/**
 * One keystroke into the field. Printable keys (a paste too) append,
 * Backspace drops the last character, Enter submits. Ctrl / Meta chords,
 * Esc and terminal sequences are left to the app layer, which reads Esc
 * and the deny chord as "skip" and Ctrl+C as "stop".
 */
export function applySecretKey(buffer: string, input: string, key: Key): SecretKeyResult {
  if (key.return) return { kind: "submit", buffer };
  if (key.backspace || key.delete) return { kind: "edit", buffer: Array.from(buffer).slice(0, -1).join("") };
  if (key.ctrl || key.meta || key.escape || key.tab) return { kind: "ignore" };
  if (input.length === 0 || input.includes("\u001b")) return { kind: "ignore" };
  // A pasted line break is the end of the value, not part of it.
  const text = input.replace(/[\u0000-\u001f\u007f]/g, "");
  if (text.length === 0) return { kind: "ignore" };
  return { kind: "edit", buffer: buffer + text };
}

/** Bullets for what was typed, never the characters. */
export function maskSecret(buffer: string): string {
  const length = Array.from(buffer).length;
  const shown = "•".repeat(Math.min(length, 32));
  return length > 32 ? `${shown}+${length - 32}` : shown;
}

/**
 * Send the typed value for `request`. `false` (with a notice) when the
 * value cannot be sent, and the field stays open for another try.
 */
export function submitShellSecret(
  request: ApprovalRequest,
  value: string,
  ctx: {
    dispatch: (action: TuiAction) => void;
    onSecretInput: ((approvalId: string, value: string) => void) | undefined;
  },
): boolean {
  if (!ctx.onSecretInput) return false;
  const checked = checkShellSecretValue(value);
  if (!checked.ok) {
    ctx.dispatch({ type: "system_message", text: `Not sent: ${checked.reason}.` });
    return false;
  }
  ctx.onSecretInput(request.approvalId, checked.value);
  ctx.dispatch({ type: "approval_resolved", approvalId: request.approvalId, approved: true });
  const job = request.secretInput ? `job ${request.secretInput.jobId}` : "the job";
  ctx.dispatch({ type: "system_message", text: `Sent to ${job} (hidden from the agent).` });
  return true;
}
