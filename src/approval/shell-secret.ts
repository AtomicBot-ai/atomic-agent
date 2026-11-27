/**
 * A secret the person types into an interactive shell job (ATO-2486):
 * a `sudo` password, an SSH key's passphrase, a database password at a
 * REPL's prompt. The model asks with `{"write": id, "secret": "…"}`
 * naming what is asked; the value goes from the person straight into the
 * job's input and never reaches the model.
 *
 * It travels as an `ApprovalRequest` of category `shell_secret` with
 * this object in `request.secretInput`, so the turn pauses where an
 * approval pauses it and every surface that receives approvals sees it.
 * The value comes back in `ApprovalDecision.secret`. The gate records
 * only the verdict (`ApprovalLedger`); no surface may log, echo or keep
 * the value. A surface that cannot take one safely (a chat bridge, where
 * the message would stay in the chat's history) shows the request as a
 * plain approval: approving it there carries no value, and the tool
 * says nothing was typed.
 *
 * Precedent: `sudo`'s own prompt and Claude Code / Codex handing a
 * password prompt to the person instead of the model.
 */

export interface ShellSecretPrompt {
  /** The job the value is typed into (`{"wait": id}` names it). */
  jobId: number;
  /** What the program asks for, in the model's words: "sudo password". */
  label: string;
  /** The job's command line, so the person sees who is asking. */
  commandLine: string;
  /** The job's last line of output (its prompt), trimmed; may be empty. */
  promptLine: string;
}

export const SHELL_SECRET_LABEL_MAX = 120;
export const SHELL_SECRET_PROMPT_LINE_MAX = 200;
/** The longest value a person can type in; a passphrase, not a file. */
export const SHELL_SECRET_MAX_CHARS = 1_024;

/** The category every surface checks (`request.category === SHELL_SECRET_CATEGORY`). */
export const SHELL_SECRET_CATEGORY = "shell_secret" as const;

/**
 * The value as it goes into the job, or an error naming what is wrong
 * (never the value itself). One trailing line break is dropped: the job
 * gets its own Enter. Inner spaces are kept: they can be part of it.
 */
export function checkShellSecretValue(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "the secret must be text" };
  const value = raw.replace(/\r?\n$/, "");
  if (value.length === 0) return { ok: false, reason: "the secret is empty" };
  if (value.length > SHELL_SECRET_MAX_CHARS) {
    return { ok: false, reason: `the secret is longer than ${SHELL_SECRET_MAX_CHARS} characters` };
  }
  if (/[\r\n\u0000]/.test(value)) {
    return { ok: false, reason: "the secret must be one line" };
  }
  return { ok: true, value };
}

/** The label, cleaned up for a prompt: one line, bounded, never empty. */
export function normalizeShellSecretLabel(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (text.length === 0) return "a password";
  return text.length > SHELL_SECRET_LABEL_MAX ? `${text.slice(0, SHELL_SECRET_LABEL_MAX - 1)}…` : text;
}

/** What a text-only surface shows: who asks, for what, and where to type it. */
export function describeShellSecretPrompt(prompt: ShellSecretPrompt): string {
  const lines = [`Job ${prompt.jobId} (${prompt.commandLine}) asks for ${prompt.label}.`];
  if (prompt.promptLine.length > 0) lines.push(`It printed: ${prompt.promptLine}`);
  lines.push("Type it in the Atomic Agent terminal or desktop window. The agent never sees it.");
  return lines.join("\n");
}
