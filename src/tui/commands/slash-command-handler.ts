import type { TuiAction } from "../tui-action.js";
import { normalizeLlamaBaseUrl } from "../persist-user-llama-url.js";
import { parseSlashCommand } from "./slash-command-parser.js";
import { resolveSlashCommand } from "./slash-commands.js";

export interface SlashDispatchCallbacks {
  onAbort(): void;
  onQuit(): void;
}

export interface SlashDispatchResult {
  /**
   * Reducer actions the caller should dispatch in order. Empty when the
   * command was unknown or required no state change.
   */
  readonly actions: readonly TuiAction[];
  /** Text to inject into the chat log as a system confirmation. */
  readonly systemMessage?: string;
  /** When true the editor buffer should be cleared after dispatch. */
  readonly clearBuffer: boolean;
  /** When true the caller should invoke `onAbort`. */
  readonly triggerAbort: boolean;
  /** When true the caller should invoke `onQuit`. */
  readonly triggerQuit: boolean;
  /** When true the caller should ask the orchestrator to open the session picker. */
  readonly triggerSessionPicker: boolean;
  /** When true the caller should ask the orchestrator to start a fresh session. */
  readonly triggerSessionNew: boolean;
  /** When true the caller should ask the orchestrator to dump the user profile. */
  readonly triggerMemoryDump: boolean;
  /** When true the caller should forward the raw buffer as a normal message. */
  readonly forwardAsMessage: boolean;
  /** When set, caller should probe this URL, persist on success, then refresh UI. */
  readonly persistLlamaUrl?: string;
  /** Task id to cancel via the orchestrator (`/task cancel <id>`). */
  readonly taskCancelId?: string;
  /** Task id to run immediately via `TaskRunner.runOne` (`/task run <id>`). */
  readonly taskRunId?: string;
}

/**
 * Pure dispatcher: converts the buffered editor string into a set of
 * reducer actions + side-effect flags. Keeping side-effect invocation in
 * the caller makes the handler unit-testable and lets the reducer stay
 * pure.
 */
export function dispatchSlashCommand(buffer: string): SlashDispatchResult {
  const parsed = parseSlashCommand(buffer);
  if (parsed === null) {
    return {
      actions: [],
      clearBuffer: false,
      triggerAbort: false,
      triggerQuit: false,
      triggerSessionPicker: false,
      triggerSessionNew: false,
      triggerMemoryDump: false,
      forwardAsMessage: true,
      persistLlamaUrl: undefined,
    };
  }
  const resolved = resolveSlashCommand(parsed.name);
  if (resolved === null) {
    return {
      actions: [],
      systemMessage: `unknown command: /${parsed.name}`,
      clearBuffer: true,
      triggerAbort: false,
      triggerQuit: false,
      triggerSessionPicker: false,
      triggerSessionNew: false,
      triggerMemoryDump: false,
      forwardAsMessage: false,
      persistLlamaUrl: undefined,
    };
  }
  switch (resolved.name) {
    case "help":
      return pureActions([], {
        systemMessage:
          "available commands: /clear /abort /quit /debug /chat /feed /logs /reasoning /world /metrics /tasks /task /expand /collapse /session /sessions /new /skills /memory /llama",
      });
    case "clear":
      return pureActions([{ type: "chat_cleared" }], {
        systemMessage: "chat cleared",
      });
    case "abort":
      return pureActions([{ type: "abort_requested" }], {
        triggerAbort: true,
        systemMessage: "abort requested",
      });
    case "quit":
      return pureActions([{ type: "quit_requested" }], {
        triggerQuit: true,
        systemMessage: "exiting",
      });
    case "debug":
      return pureActions([{ type: "ui_mode_toggled" }]);
    case "chat":
      return pureActions([{ type: "ui_mode_set", mode: "chat" }]);
    case "feed":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "feed" },
      ]);
    case "logs":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "logs" },
      ]);
    case "reasoning":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "reasoning" },
      ]);
    case "world":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "world" },
      ]);
    case "metrics":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "metrics" },
      ]);
    case "expand":
      return pureActions([{ type: "tool_expand_all_set", expanded: true }]);
    case "collapse":
      return pureActions([{ type: "tool_expand_all_set", expanded: false }]);
    case "session":
      return pureActions([], {
        systemMessage: "use /sessions to switch, /new to start fresh",
      });
    case "sessions":
      return pureActions([], { triggerSessionPicker: true });
    case "new":
      return pureActions([], { triggerSessionNew: true });
    case "skills":
      return pureActions([], {
        systemMessage: "loaded skills are shown in /debug → World tab",
      });
    case "memory":
      return pureActions([], { triggerMemoryDump: true });
    case "tasks":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "tasks" },
      ]);
    case "task":
      return dispatchTaskSub(parsed.args);
    case "llama": {
      const argPart = parsed.args.trim();
      if (argPart.length === 0) {
        return pureActions([], {
          systemMessage:
            "usage: /llama <base-url> — probes GET /health then saves to config.json (API key: ATOMIC_AGENT_LLAMA_API_KEY)",
        });
      }
      try {
        const url = normalizeLlamaBaseUrl(argPart);
        return {
          actions: [],
          clearBuffer: true,
          triggerAbort: false,
          triggerQuit: false,
          triggerSessionPicker: false,
          triggerSessionNew: false,
          triggerMemoryDump: false,
          forwardAsMessage: false,
          persistLlamaUrl: url,
        };
      } catch {
        return pureActions([], { systemMessage: "invalid URL for /llama" });
      }
    }
    default:
      return pureActions([], {
        systemMessage: `command /${resolved.name} not yet implemented`,
      });
  }
}

function pureActions(
  actions: readonly TuiAction[],
  overrides: Partial<
    Omit<SlashDispatchResult, "actions" | "forwardAsMessage">
  > = {},
): SlashDispatchResult {
  return {
    actions,
    clearBuffer: true,
    triggerAbort: false,
    triggerQuit: false,
    triggerSessionPicker: false,
    triggerSessionNew: false,
    triggerMemoryDump: false,
    forwardAsMessage: false,
    persistLlamaUrl: undefined,
    ...overrides,
  };
}

/**
 * Sub-dispatcher for `/task <verb> [args]`. Accepted verbs:
 *   - `new`         — open the create form in the Tasks tab.
 *   - `cancel <id>` — enqueue a cancellation side-effect.
 *   - `run <id>`    — enqueue a run-now side-effect.
 */
function dispatchTaskSub(rawArgs: string): SlashDispatchResult {
  const [verb, ...rest] = rawArgs.trim().split(/\s+/);
  const verbLower = (verb ?? "").toLowerCase();
  if (verbLower === "new" || verbLower === "create") {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "tasks" },
      { type: "tasks_create_form_opened" },
    ]);
  }
  if (verbLower === "cancel") {
    const id = rest.join(" ").trim();
    if (id.length === 0) {
      return pureActions([], { systemMessage: "usage: /task cancel <id>" });
    }
    return pureActions([], { taskCancelId: id });
  }
  if (verbLower === "run") {
    const id = rest.join(" ").trim();
    if (id.length === 0) {
      return pureActions([], { systemMessage: "usage: /task run <id>" });
    }
    return pureActions([], { taskRunId: id });
  }
  return pureActions([], {
    systemMessage: "usage: /task new | /task cancel <id> | /task run <id>",
  });
}
