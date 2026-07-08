import {
  cancelChat,
  createSession,
  deleteSession,
  getSessionState,
  listSessions,
  pingSidecar,
  resolveApproval as resolveApprovalApi,
  sendChat,
} from "@/lib/agent-api";
import { turnsToMessages } from "@/lib/session-adapter";
import { useSessionStore } from "@/stores/session-store";

/**
 * Imperative chat actions operating on the shared session store. These are
 * plain functions (no React) so both router components and the event
 * controller can drive the sidecar without prop drilling.
 */

/**
 * Boot the sidecar connection: verify status, ping, and load the session list.
 * Returns the most recent session id to resume, or `null` when there are no
 * sessions yet (the UI then shows the New Chat draft). No empty session is
 * created on boot — sessions are only persisted once the user sends a message.
 */
export async function bootSidecar(): Promise<string | null> {
  const store = useSessionStore.getState();
  try {
    const status = await window.agent.getStatus();
    if (!status.running) {
      throw new Error(status.error ?? "sidecar is not running");
    }

    const ping = await pingSidecar();
    store.setStatusText(`Connected · ${ping.llamaUrl}`);

    const sessions = await listSessions();
    store.upsertSummaries(sessions);

    store.setConnected(true);
    store.setBootError(null);
    store.setStatusText("Ready");
    return sessions[0]?.id ?? null;
  } catch (err) {
    store.setBootError(err instanceof Error ? err.message : String(err));
    store.setStatusText("Sidecar unavailable");
    store.setConnected(false);
    return null;
  }
}

/** Create a fresh session and return its id (or `null` on failure). */
export async function newSession(): Promise<string | null> {
  const store = useSessionStore.getState();
  try {
    const created = await createSession();
    store.addOrUpdateSummary(created);
    store.setMessages(created.id, []);
    return created.id;
  } catch (err) {
    store.setStatusText(err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Lazily create a backend session and send the first message into it. Backs
 * the New Chat draft composer: an empty session is never persisted until the
 * user actually sends something. Returns the new session id, or `null` on
 * failure. `sendMessage` is fired without awaiting — its store mutations
 * (optimistic user message + running phase) run synchronously before the
 * network call, so the caller can navigate to the thread immediately.
 */
export async function startDraftChat(text: string): Promise<string | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const id = await newSession();
  if (!id) return null;
  useSessionStore.getState().setActive(id);
  void sendMessage(id, trimmed);
  return id;
}

/** Load a session's full transcript into the store (once). */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const store = useSessionStore.getState();
  const entry = store.entries[sessionId];
  if (entry?.loaded) return;
  try {
    const state = await getSessionState(sessionId);
    store.setMessages(sessionId, state ? turnsToMessages(state.turns) : []);
  } catch (err) {
    store.setStatusText(err instanceof Error ? err.message : String(err));
  }
}

/** Delete a session and drop it from the store. */
export async function removeSession(sessionId: string): Promise<void> {
  const store = useSessionStore.getState();
  try {
    await deleteSession(sessionId);
  } catch {
    // Removing locally regardless keeps the UI responsive; the next
    // session.list refresh reconciles any drift.
  }
  store.removeSession(sessionId);
}

/** Send a user message to a session and drive its turn. */
export async function sendMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const store = useSessionStore.getState();
  const entry = store.entries[sessionId];
  if (!entry || entry.phase === "running") return;

  store.appendUserMessage(sessionId, trimmed);
  store.startTurn(sessionId);
  store.setStatusText("Sending…");

  try {
    await sendChat(sessionId, trimmed);
  } catch (err) {
    store.failSession(
      sessionId,
      err instanceof Error ? err.message : String(err),
    );
    store.setStatusText("chat.send failed");
  }
}

/** Cancel the in-flight turn of a session. */
export async function cancelTurn(sessionId: string): Promise<void> {
  const store = useSessionStore.getState();
  try {
    await cancelChat(sessionId);
  } catch {
    // Best-effort — turn.finished will still settle the UI.
  }
  store.endTurn(sessionId);
  store.setStatusText("Cancelled");
}

/** Resolve the currently pending approval request. */
export async function resolveApproval(approved: boolean): Promise<void> {
  const store = useSessionStore.getState();
  const pending = store.pendingApproval;
  if (!pending) return;
  try {
    await resolveApprovalApi(pending.approvalId, approved);
  } finally {
    store.setPendingApproval(null);
  }
}
