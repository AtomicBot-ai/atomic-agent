import { useEffect, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import type {
  ApprovalRequestPayload,
  AssistantDeltaPayload,
  AssistantReplyPayload,
  LlmUnavailablePayload,
  LogPayload,
  ReasoningPayload,
  SessionFailedPayload,
  StepFinishedPayload,
  StepStartedPayload,
  ToolCallResultPayload,
  ToolCallStartedPayload,
  TurnFinishedPayload,
  UserMessagePayload,
} from "@agent/sidecar/index.js";

import { isHiddenTool } from "@/chat-types";
import { bootSidecar } from "@/lib/chat-actions";
import { listSessions } from "@/lib/agent-api";
import { useSessionStore } from "@/stores/session-store";
import { useModelStore } from "@/stores/model-store";

/**
 * Single mounted controller: boots the sidecar, routes every `SidecarEvent`
 * into the session store keyed by `sessionId`, and reacts to sidecar
 * process status changes. UI components read state from the store directly
 * and call the imperative helpers in `lib/chat-actions`.
 */
export function useAgentController(): void {
  const router = useRouter();
  const booted = useRef(false);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootSidecar().then((activeId) => {
      void useModelStore.getState().refresh();
      if (activeId) {
        useSessionStore.getState().setActive(activeId);
        void router.navigate({
          to: "/thread/$sessionId",
          params: { sessionId: activeId },
        });
      }
    });
  }, [router]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // ⌘/Ctrl+N opens the New Chat draft (no backend session until first send).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "n") {
        e.preventDefault();
        useSessionStore.getState().setActive(null);
        void router.navigate({ to: "/" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  useEffect(() => {
    const unsubscribe = window.agent.onStatusChange((status) => {
      if (!status.running) {
        const store = useSessionStore.getState();
        store.setConnected(false);
        store.setBootError(status.error ?? "sidecar is not running");
        store.setStatusText("Sidecar unavailable");
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.agent.onEvent((event) => {
      const store = useSessionStore.getState();
      const sid = (event.payload as { sessionId?: string }).sessionId;

      switch (event.type) {
        case "llm.unavailable":
          store.setLlmUnavailable(event.payload as LlmUnavailablePayload);
          break;
        case "approval.request":
          store.setPendingApproval(event.payload as ApprovalRequestPayload);
          break;
        case "user.message":
          if (sid) store.noteUserMessage(sid, (event.payload as UserMessagePayload).text);
          break;
        case "turn.started":
          if (sid) {
            store.markRunning(sid);
            store.setStatusText("Thinking…");
          }
          break;
        case "step.started":
          store.setStatusText(
            `Step ${String((event.payload as StepStartedPayload).stepIndex)}…`,
          );
          break;
        case "step.finished":
          store.setStatusText(
            (event.payload as StepFinishedPayload).summary || "Step done",
          );
          break;
        case "tool.call_started":
          if (sid) {
            const p = event.payload as ToolCallStartedPayload;
            if (!isHiddenTool(p.tool)) {
              store.addToolStart(sid, p.tool, p.args);
              store.setStatusText(`Running ${p.tool}…`);
            }
          }
          break;
        case "tool.call_result":
          if (sid) {
            const p = event.payload as ToolCallResultPayload;
            if (!isHiddenTool(p.tool)) {
              store.resolveToolResult(sid, p.tool, p.status, p.summary);
            }
          }
          break;
        case "reasoning.delta":
          if (sid) store.appendReasoning(sid, (event.payload as ReasoningPayload).text);
          break;
        case "reasoning":
          if (sid) store.setReasoning(sid, (event.payload as ReasoningPayload).text);
          break;
        case "assistant.delta":
          if (sid) store.appendDelta(sid, (event.payload as AssistantDeltaPayload).text);
          break;
        case "assistant.reply":
          if (sid) store.finalizeAssistant(sid, (event.payload as AssistantReplyPayload).text);
          break;
        case "turn.finished":
          if (sid) {
            const p = event.payload as TurnFinishedPayload;
            store.endTurn(sid);
            store.setStatusText(p.reason === "reply" ? "Ready" : `Turn ended: ${p.reason}`);
            void refreshTitles();
            void useModelStore.getState().refresh();
          }
          break;
        case "session.failed":
          if (sid) {
            const p = event.payload as SessionFailedPayload;
            store.failSession(sid, p.error);
            store.setStatusText(`Failed: ${p.error}`);
          }
          break;
        case "log": {
          const log = event.payload as LogPayload;
          if (log.message.includes("sidecar booted")) {
            store.setLlmUnavailable(null);
          }
          break;
        }
        default:
          break;
      }
    });
    return unsubscribe;
  }, []);
}

/** Re-pull session summaries so derived titles refresh in the sidebar. */
async function refreshTitles(): Promise<void> {
  try {
    const sessions = await listSessions();
    useSessionStore.getState().upsertSummaries(sessions);
  } catch {
    // Non-fatal: titles simply stay stale until the next refresh.
  }
}
