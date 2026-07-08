import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { StickToBottom } from "use-stick-to-bottom";

import type { ChatMessage } from "@/chat-types";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { ChatHeader } from "@/containers/chat-header";
import { ChatInput } from "@/containers/chat-input";
import { MessageItem } from "@/containers/message-item";
import { ApprovalPrompt } from "@/containers/approval-prompt";
import { LlmBanner } from "@/containers/llm-banner";
import { useTranslation } from "@/i18n";
import { loadSessionHistory } from "@/lib/chat-actions";
import { useSessionStore } from "@/stores/session-store";

interface ChatViewProps {
  /**
   * Draft ("New Chat") mode: no backend session exists yet. The active session
   * is deliberately ignored so the composer starts blank; the first send
   * lazily creates a session and routes to its thread.
   */
  draft?: boolean;
}

/**
 * Chat surface for the routed session. Reads the session id from the route,
 * activates it, lazily loads its transcript, and renders either the centered
 * empty-state hero (no messages / draft) or the message stream + pinned
 * composer.
 */
export function ChatView({ draft = false }: ChatViewProps): React.ReactElement {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { sessionId?: string };

  const activeId = useSessionStore((s) => s.activeId);
  const effectiveId = draft ? null : (params.sessionId ?? activeId);

  const entry = useSessionStore((s) =>
    effectiveId ? s.entries[effectiveId] : undefined,
  );

  useEffect(() => {
    if (!effectiveId) return;
    useSessionStore.getState().setActive(effectiveId);
    void loadSessionHistory(effectiveId);
  }, [effectiveId]);

  const messages = buildDisplayMessages(entry);
  const showThinking = isThinking(entry);

  // Draft, or an existing session with no messages: centered hero + composer.
  // In draft mode `effectiveId` is null and `ChatInput` creates the session
  // on the first send.
  if (draft || messages.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader />
        <LlmBanner />
        <div className="inline-flex h-full flex-col justify-center overflow-y-auto px-3">
          <div className="mx-auto -mt-20 w-full md:w-4/5 xl:w-4/6">
            <div className="mb-4 text-center">
              <h1 className="mt-2 font-studio text-2xl font-medium">
                {t("chat:description", {
                  defaultValue: "How can I help you today?",
                })}
              </h1>
            </div>
            <ChatInput sessionId={effectiveId} autoFocus />
          </div>
        </div>
        {effectiveId ? <ApprovalPrompt sessionId={effectiveId} /> : null}
      </div>
    );
  }

  // Non-draft with messages implies a concrete session id; narrow for TS.
  if (!effectiveId) return <></>;

  return (
    <div className="flex h-full flex-col">
      <ChatHeader />
      <LlmBanner />
      <StickToBottom
        className="relative min-h-0 flex-1 overflow-y-auto"
        resize="smooth"
        initial="smooth"
      >
        <StickToBottom.Content className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {messages.map((m) => (
            <MessageItem key={m.id} message={m} />
          ))}
          {showThinking ? (
            <Shimmer className="text-sm" duration={1}>
              {t("common:working", { defaultValue: "Working…" })}
            </Shimmer>
          ) : null}
        </StickToBottom.Content>
      </StickToBottom>
      <ApprovalPrompt sessionId={effectiveId} />
      <div className="mx-auto w-full max-w-3xl px-4 pb-4">
        <ChatInput sessionId={effectiveId} />
      </div>
    </div>
  );
}

/**
 * True while a turn is running but nothing has streamed yet (no text, no
 * reasoning, no tool steps). Drives the "working" shimmer so the UI never
 * feels frozen between "send" and the first token / tool call.
 */
function isThinking(
  entry: ReturnType<typeof useSessionStore.getState>["entries"][string] | undefined,
): boolean {
  if (!entry || entry.phase !== "running") return false;
  const { draft } = entry;
  if (!draft) return true;
  return (
    draft.text.length === 0 &&
    draft.reasoning.length === 0 &&
    draft.steps.length === 0
  );
}

function buildDisplayMessages(
  entry: ReturnType<typeof useSessionStore.getState>["entries"][string] | undefined,
): ChatMessage[] {
  if (!entry) return [];
  const messages = [...entry.messages];
  if (entry.draft) {
    const { draft } = entry;
    const hasContent =
      draft.text.length > 0 ||
      draft.reasoning.length > 0 ||
      draft.steps.length > 0;
    if (hasContent) {
      messages.push({
        id: "__draft__",
        role: "assistant",
        text: draft.text,
        reasoning: draft.reasoning || undefined,
        steps: draft.steps.length > 0 ? draft.steps : undefined,
        streaming: true,
      });
    }
  }
  return messages;
}
