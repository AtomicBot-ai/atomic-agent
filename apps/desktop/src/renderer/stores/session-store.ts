import { create } from "zustand";
import type { SessionSummary } from "@agent/sidecar/index.js";

import type {
  ApprovalRequestPayload,
  ChatMessage,
  LlmUnavailablePayload,
  ToolStep,
  TurnPhase,
} from "@/chat-types";
import { messageId } from "@/lib/session-adapter";

interface DraftAssistant {
  text: string;
  reasoning: string;
  steps: ToolStep[];
}

export interface SessionEntry {
  summary: SessionSummary;
  messages: ChatMessage[];
  phase: TurnPhase;
  draft: DraftAssistant | null;
  /** Whether the full transcript was loaded via `session.get`. */
  loaded: boolean;
}

interface SessionStoreState {
  connected: boolean;
  bootError: string | null;
  statusText: string;
  llmUnavailable: LlmUnavailablePayload | null;
  pendingApproval: ApprovalRequestPayload | null;
  activeId: string | null;
  order: string[];
  entries: Record<string, SessionEntry>;

  setConnected: (connected: boolean) => void;
  setBootError: (error: string | null) => void;
  setStatusText: (text: string) => void;
  setLlmUnavailable: (payload: LlmUnavailablePayload | null) => void;
  setPendingApproval: (payload: ApprovalRequestPayload | null) => void;
  setActive: (id: string | null) => void;

  upsertSummaries: (summaries: SessionSummary[]) => void;
  addOrUpdateSummary: (summary: SessionSummary) => void;
  removeSession: (id: string) => void;
  setMessages: (id: string, messages: ChatMessage[]) => void;

  appendUserMessage: (id: string, text: string) => void;
  noteUserMessage: (id: string, text: string) => void;
  startTurn: (id: string) => void;
  markRunning: (id: string) => void;
  appendDelta: (id: string, text: string) => void;
  appendReasoning: (id: string, text: string) => void;
  setReasoning: (id: string, text: string) => void;
  addToolStart: (id: string, tool: string, args: unknown) => void;
  resolveToolResult: (
    id: string,
    tool: string,
    status: "ok" | "error",
    summary: string,
  ) => void;
  finalizeAssistant: (id: string, text: string, reasoning?: string) => void;
  endTurn: (id: string) => void;
  failSession: (id: string, error: string) => void;
}

function emptyEntry(summary: SessionSummary): SessionEntry {
  return { summary, messages: [], phase: "idle", draft: null, loaded: false };
}

export const useSessionStore = create<SessionStoreState>((set) => {
  /** Immutably patch a single session entry, no-op when absent. */
  const patchEntry = (
    id: string,
    patch: (entry: SessionEntry) => SessionEntry,
  ): void => {
    set((state) => {
      const entry = state.entries[id];
      if (!entry) return state;
      return { entries: { ...state.entries, [id]: patch(entry) } };
    });
  };

  return {
    connected: false,
    bootError: null,
    statusText: "Connecting…",
    llmUnavailable: null,
    pendingApproval: null,
    activeId: null,
    order: [],
    entries: {},

    setConnected: (connected) => set({ connected }),
    setBootError: (bootError) => set({ bootError }),
    setStatusText: (statusText) => set({ statusText }),
    setLlmUnavailable: (llmUnavailable) => set({ llmUnavailable }),
    setPendingApproval: (pendingApproval) => set({ pendingApproval }),
    setActive: (activeId) => set({ activeId }),

    upsertSummaries: (summaries) =>
      set((state) => {
        const entries = { ...state.entries };
        for (const summary of summaries) {
          const existing = entries[summary.id];
          entries[summary.id] = existing
            ? { ...existing, summary }
            : emptyEntry(summary);
        }
        const order = summaries.map((s) => s.id);
        for (const id of state.order) {
          if (!order.includes(id)) order.push(id);
        }
        return { entries, order };
      }),

    addOrUpdateSummary: (summary) =>
      set((state) => {
        const existing = state.entries[summary.id];
        const entries = {
          ...state.entries,
          [summary.id]: existing
            ? { ...existing, summary }
            : emptyEntry(summary),
        };
        const order = state.order.includes(summary.id)
          ? state.order
          : [summary.id, ...state.order];
        return { entries, order };
      }),

    removeSession: (id) =>
      set((state) => {
        const entries = { ...state.entries };
        delete entries[id];
        const order = state.order.filter((x) => x !== id);
        const activeId =
          state.activeId === id ? (order[0] ?? null) : state.activeId;
        return { entries, order, activeId };
      }),

    setMessages: (id, messages) =>
      patchEntry(id, (entry) => ({ ...entry, messages, loaded: true })),

    appendUserMessage: (id, text) =>
      patchEntry(id, (entry) => ({
        ...entry,
        messages: [
          ...entry.messages,
          { id: messageId(), role: "user", text },
        ],
      })),

    noteUserMessage: (id, text) =>
      patchEntry(id, (entry) => {
        const last = entry.messages[entry.messages.length - 1];
        if (last && last.role === "user" && last.text === text) return entry;
        return {
          ...entry,
          messages: [
            ...entry.messages,
            { id: messageId(), role: "user", text },
          ],
        };
      }),

    startTurn: (id) =>
      patchEntry(id, (entry) => ({
        ...entry,
        phase: "running",
        draft: { text: "", reasoning: "", steps: [] },
      })),

    markRunning: (id) =>
      patchEntry(id, (entry) => ({
        ...entry,
        phase: "running",
        draft: entry.draft ?? { text: "", reasoning: "", steps: [] },
      })),

    appendDelta: (id, text) =>
      patchEntry(id, (entry) => {
        const draft = entry.draft ?? { text: "", reasoning: "", steps: [] };
        return { ...entry, draft: { ...draft, text: draft.text + text } };
      }),

    appendReasoning: (id, text) =>
      patchEntry(id, (entry) => {
        const draft = entry.draft ?? { text: "", reasoning: "", steps: [] };
        return {
          ...entry,
          draft: { ...draft, reasoning: draft.reasoning + text },
        };
      }),

    setReasoning: (id, text) =>
      patchEntry(id, (entry) => {
        const draft = entry.draft ?? { text: "", reasoning: "", steps: [] };
        return { ...entry, draft: { ...draft, reasoning: text } };
      }),

    addToolStart: (id, tool, args) =>
      patchEntry(id, (entry) => {
        const draft = entry.draft ?? { text: "", reasoning: "", steps: [] };
        return {
          ...entry,
          draft: {
            ...draft,
            steps: [...draft.steps, { tool, args, status: "running" }],
          },
        };
      }),

    resolveToolResult: (id, tool, status, summary) =>
      patchEntry(id, (entry) => {
        if (!entry.draft) return entry;
        const steps = [...entry.draft.steps];
        for (let i = steps.length - 1; i >= 0; i -= 1) {
          if (steps[i]!.tool === tool && steps[i]!.status === "running") {
            steps[i] = { ...steps[i]!, status, summary };
            return { ...entry, draft: { ...entry.draft, steps } };
          }
        }
        steps.push({ tool, status, summary });
        return { ...entry, draft: { ...entry.draft, steps } };
      }),

    finalizeAssistant: (id, text, reasoning) =>
      patchEntry(id, (entry) => {
        const draft = entry.draft;
        const message: ChatMessage = {
          id: messageId(),
          role: "assistant",
          text,
          reasoning: reasoning || draft?.reasoning || undefined,
          steps: draft && draft.steps.length > 0 ? draft.steps : undefined,
        };
        return { ...entry, messages: [...entry.messages, message], draft: null };
      }),

    endTurn: (id) =>
      patchEntry(id, (entry) => {
        if (!entry.draft) return { ...entry, phase: "idle" };
        const { draft } = entry;
        const hasContent = draft.text.length > 0 || draft.steps.length > 0;
        if (!hasContent) return { ...entry, phase: "idle", draft: null };
        const message: ChatMessage = {
          id: messageId(),
          role: "assistant",
          text: draft.text,
          reasoning: draft.reasoning || undefined,
          steps: draft.steps.length > 0 ? draft.steps : undefined,
        };
        return {
          ...entry,
          phase: "idle",
          draft: null,
          messages: [...entry.messages, message],
        };
      }),

    failSession: (id, error) =>
      patchEntry(id, (entry) => ({
        ...entry,
        phase: "idle",
        draft: null,
        messages: [
          ...entry.messages,
          { id: messageId(), role: "assistant", text: `Error: ${error}` },
        ],
      })),
  };
});
