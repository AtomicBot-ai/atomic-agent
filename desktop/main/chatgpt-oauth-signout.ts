/**
 * ATO-2511: Settings › Models' "Sign out" on the ChatGPT sign-in provider
 * (`subscription-oauth`, added by `atag login chatgpt`, ATO-1454). The
 * bundled agent does the work (`atag logout chatgpt`, src/cli/login-command.ts
 * logoutCommand): it deletes `<stateDir>/auth/chatgpt.json` and keeps the
 * provider entry, which then asks to sign in again when it is used. This
 * module runs it and reads the agent's fixed sentences; the IPC
 * (chatgpt-oauth-ipc.ts) only wires it.
 *
 * The window gets `{ ok, state, reason?, detail? }`. `detail` is the agent's
 * own output, trimmed, shown only behind "Details" (it may name the token
 * file's path); it never carries a token, since logout prints none.
 *
 * Electron-free (run is injected) so it is under unit test
 * (desktop/test/chatgpt-oauth-signout.test.mjs).
 */

export type ChatgptSignOutReason = "unsupported" | "failed";

export interface ChatgptSignOutResult {
  ok: boolean;
  state: "signed_out" | "failed";
  /** On success: whether there was a stored sign-in to delete. */
  hadSignIn?: boolean;
  reason?: ChatgptSignOutReason;
  /** The agent's output, for the "Details" disclosure only. */
  detail?: string;
}

export interface ChatgptSignOutDeps {
  /** A short `atag` run (agent-cli.ts atagRun); output is returned on a non-zero exit too. */
  run: (args: string[], timeoutMs: number) => Promise<{ ok?: boolean; stdout: string; stderr: string; error?: string }>;
}

/** The agent deletes one small file; anything longer is a hung process. */
export const SIGN_OUT_TIMEOUT_MS = 15_000;
/** Enough for the agent's one line and a short error; the rest is dropped. */
const MAX_DETAIL = 400;

function detailOf(text: string): string | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_DETAIL) : undefined;
}

/**
 * The agent's answer, from its own fixed sentences (logoutCommand):
 * "Signed out of ChatGPT ..." or "Not signed in to ChatGPT; nothing to
 * delete." are both a signed-out end; anything else failed. An agent older
 * than `logout` says "unknown command".
 */
export function parseSignOut(out: { stdout: string; stderr: string; error?: string }): ChatgptSignOutResult {
  const text = `${out.stdout}\n${out.stderr}\n${out.error ?? ""}`;
  if (/Signed out of ChatGPT/.test(out.stdout)) return { ok: true, state: "signed_out", hadSignIn: true };
  if (/Not signed in to ChatGPT/.test(out.stdout)) return { ok: true, state: "signed_out", hadSignIn: false };
  const detail = detailOf(text);
  const reason: ChatgptSignOutReason = /unknown command/i.test(text) ? "unsupported" : "failed";
  return { ok: false, state: "failed", reason, ...(detail ? { detail } : {}) };
}

/** Runs `atag logout chatgpt` once. Never throws. */
export async function chatgptSignOut(deps: ChatgptSignOutDeps): Promise<ChatgptSignOutResult> {
  try {
    const r = await deps.run(["logout", "chatgpt"], SIGN_OUT_TIMEOUT_MS);
    return parseSignOut(r);
  } catch (err) {
    const detail = detailOf(err instanceof Error ? err.message : String(err));
    return { ok: false, state: "failed", reason: "failed", ...(detail ? { detail } : {}) };
  }
}
