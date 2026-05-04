import type { TuiAction } from "../tui-action.js";
import { normalizeLocalLlmBaseUrl } from "../persist-user-local-models-config.js";
import { parseSlashCommand } from "./slash-command-parser.js";
import { resolveSlashCommand, SLASH_COMMANDS } from "./slash-commands.js";

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
  /** When true the caller should ask the orchestrator to list the skill catalog in chat. */
  readonly triggerSkillCatalogDump: boolean;
  /** When true the caller should write the TUI debug zip (`/dump`). */
  readonly triggerDebugBundleDump: boolean;
  /** When true the caller should forward the raw buffer as a normal message. */
  readonly forwardAsMessage: boolean;
  /** When set, caller should probe this URL, persist on success, then refresh UI. */
  readonly persistLlamaUrl?: string;
  /** Task id to cancel via the orchestrator (`/task cancel <id>`). */
  readonly taskCancelId?: string;
  /** Task id to run immediately via `TaskRunner.runOne` (`/task run <id>`). */
  readonly taskRunId?: string;
  /** Skill name to enable via the orchestrator (`/skill enable <name>`). */
  readonly skillEnableName?: string;
  /** Skill name to disable via the orchestrator (`/skill disable <name>`). */
  readonly skillDisableName?: string;
  readonly localModelsPullModelId?: string;
  readonly localModelsUseModelId?: string;
  readonly triggerLocalModelsStatus?: boolean;
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
      triggerSkillCatalogDump: false,
      triggerDebugBundleDump: false,
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
      triggerSkillCatalogDump: false,
      triggerDebugBundleDump: false,
      forwardAsMessage: false,
      persistLlamaUrl: undefined,
    };
  }
  switch (resolved.name) {
    case "dump":
      return pureActions([], {
        triggerDebugBundleDump: true,
        systemMessage:
          "debug bundle started — watch the runtime feed for the zip path when done",
      });
    case "help":
      return pureActions([], {
        systemMessage: formatSlashCommandHelp(),
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
      return dispatchSkillsSub(parsed.args);
    case "skill":
      return dispatchSkillSub(parsed.args);
    case "memory":
      return pureActions([], { triggerMemoryDump: true });
    case "models":
      return dispatchModelsSub(parsed.args);
    case "tasks":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "tasks" },
      ]);
    case "task":
      return dispatchTaskSub(parsed.args);
    default:
      return pureActions([], {
        systemMessage: `command /${resolved.name} not yet implemented`,
      });
  }
}

/** One block of text for `/help`, built from the canonical command registry. */
function formatSlashCommandHelp(): string {
  const lines = SLASH_COMMANDS.map((cmd) => {
    const aliasPart =
      cmd.aliases && cmd.aliases.length > 0
        ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
        : "";
    return `  /${cmd.name}${aliasPart} — ${cmd.description}`;
  });
  return ["slash commands:", ...lines].join("\n");
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
    triggerSkillCatalogDump: false,
    triggerDebugBundleDump: false,
    forwardAsMessage: false,
    persistLlamaUrl: undefined,
    taskCancelId: undefined,
    taskRunId: undefined,
    skillEnableName: undefined,
    skillDisableName: undefined,
    localModelsPullModelId: undefined,
    localModelsUseModelId: undefined,
    triggerLocalModelsStatus: false,
    ...overrides,
  };
}

/**
 * Sub-dispatcher for `/models [verb] [args]`. Accepted shapes:
 *   - (bare)        — open the Models tab.
 *   - `pull <id>`   — open the tab and kick off a pull for the given id.
 *   - `use <id>`    — open the tab and set the given id as active.
 *   - `status`      — emit the managed-runtime status line in the feed.
 *   - `<base-url>`  — persist the base URL for external mode (back-compat).
 */
function dispatchModelsSub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  const bits = argPart.split(/\s+/).filter(Boolean);
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "models" },
    ]);
  }
  if (bits[0] === "pull" && bits[1]) {
    return {
      ...pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "models" },
      ]),
      localModelsPullModelId: bits[1],
    };
  }
  if (bits[0] === "use" && bits[1]) {
    return {
      ...pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "models" },
      ]),
      localModelsUseModelId: bits[1],
    };
  }
  if (bits[0] === "status") {
    return pureActions([], { triggerLocalModelsStatus: true });
  }
  try {
    const url = normalizeLocalLlmBaseUrl(argPart);
    return { ...pureActions([]), persistLlamaUrl: url };
  } catch {
    return pureActions([], {
      systemMessage:
        "usage: /models | /models pull <id> | /models use <id> | /models status | /models <base-url>",
    });
  }
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

/**
 * Sub-dispatcher for `/skills [verb]`. Bare `/skills` opens the Skills
 * tab (the visual catalog). The legacy "dump catalog in chat" flow is
 * preserved under `/skills dump` for users who want a flat text dump
 * piped through the chat transcript (e.g. agent-readable output).
 */
function dispatchSkillsSub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "skills" },
    ]);
  }
  if (argPart.toLowerCase() === "dump") {
    return pureActions([], { triggerSkillCatalogDump: true });
  }
  return pureActions([], {
    systemMessage: "usage: /skills | /skills dump",
  });
}

/**
 * Sub-dispatcher for `/skill <verb> <name>`. Accepted verbs:
 *   - `enable <name>`  — enable a previously disabled skill.
 *   - `disable <name>` — hide a skill from the registry without deleting files.
 */
function dispatchSkillSub(rawArgs: string): SlashDispatchResult {
  const [verb, ...rest] = rawArgs.trim().split(/\s+/);
  const verbLower = (verb ?? "").toLowerCase();
  if (verbLower === "enable") {
    const name = rest.join(" ").trim();
    if (name.length === 0) {
      return pureActions([], { systemMessage: "usage: /skill enable <name>" });
    }
    return pureActions([], { skillEnableName: name });
  }
  if (verbLower === "disable") {
    const name = rest.join(" ").trim();
    if (name.length === 0) {
      return pureActions([], { systemMessage: "usage: /skill disable <name>" });
    }
    return pureActions([], { skillDisableName: name });
  }
  return pureActions([], {
    systemMessage: "usage: /skill enable <name> | /skill disable <name>",
  });
}
