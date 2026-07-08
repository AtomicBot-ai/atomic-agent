import type {
  ChatSendResult,
  ModelsStatusResult,
  PingResult,
  ProviderListResult,
  ProviderSetActiveResult,
  SessionCreateResult,
  SessionDeleteResult,
  SessionListResult,
  SessionSummary,
} from "@agent/sidecar/index.js";
import type { SessionState } from "@agent/session/index.js";

/** Read-only backend status projected by the sidecar `models.status` command. */
export type ModelsStatus = ModelsStatusResult["status"];

/** One provider row from the sidecar `provider.list` command. */
export type ProviderSummary = ProviderListResult["providers"][number];

/** Registered providers plus the currently active text backend id. */
export interface ProvidersSnapshot {
  providers: ProviderSummary[];
  activeTextId: string;
}

/**
 * Typed thin wrappers over `window.agent.request`. Each helper unwraps the
 * `SidecarResponse` envelope and throws on `ok: false` so callers can use
 * plain try/catch.
 */

async function call<T>(type: string, payload: unknown): Promise<T> {
  const response = await window.agent.request(type as never, payload);
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${type} failed`);
  }
  return response.payload as T;
}

export async function pingSidecar(): Promise<PingResult> {
  return call<PingResult>("ping", {});
}

export async function fetchModelsStatus(): Promise<ModelsStatus> {
  const result = await call<ModelsStatusResult>("models.status", {});
  return result.status;
}

/** List registered LLM providers and which one is the active text backend. */
export async function listProviders(): Promise<ProvidersSnapshot> {
  const result = await call<ProviderListResult>("provider.list", {});
  return { providers: result.providers, activeTextId: result.activeTextId };
}

/** Hot-swap the active text provider; returns the new active id. */
export async function setActiveProvider(id: string): Promise<string> {
  const result = await call<ProviderSetActiveResult>("provider.setActive", {
    id,
  });
  return result.activeTextId;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const result = await call<SessionListResult>("session.list", {});
  return result.sessions;
}

export async function createSession(): Promise<SessionSummary> {
  const result = await call<SessionCreateResult>("session.create", {});
  return result.session;
}

export async function getSessionState(
  sessionId: string,
): Promise<SessionState | null> {
  const result = await call<{ session: SessionState | null }>("session.get", {
    sessionId,
  });
  return result.session;
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  const result = await call<SessionDeleteResult>("session.delete", {
    sessionId,
  });
  return result.deleted;
}

export async function sendChat(
  sessionId: string,
  text: string,
): Promise<ChatSendResult> {
  return call<ChatSendResult>("chat.send", { sessionId, text });
}

export async function cancelChat(sessionId: string): Promise<void> {
  await call("chat.cancel", { sessionId });
}

export async function resolveApproval(
  approvalId: string,
  approved: boolean,
): Promise<void> {
  await call("approval.resolve", { approvalId, approved });
}
