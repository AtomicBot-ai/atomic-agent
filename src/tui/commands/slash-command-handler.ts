import {
  CODING_MODES,
  codingModeLook,
  type CodingMode,
} from "../coding-mode.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import { parsePositiveInt } from "../../config/config-schema.js";
import type { WhileBusySubmitMode } from "../../config/index.js";
import type { TuiAction } from "../tui-action.js";
import { normalizeLocalLlmBaseUrl } from "../persist-user-local-models-config.js";
import { isThemeName, THEME_NAMES } from "../theme/theme.js";
import { parseSlashCommand } from "./slash-command-parser.js";
import { resolveSlashCommand, SLASH_COMMANDS } from "./slash-commands.js";
import { renderToolsOverview, renderToolsSearch } from "./tools-listing.js";

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
  /** When true the caller should open a new OS terminal window (`/window`). */
  readonly triggerNewWindow: boolean;
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
  /** When true, browse the skill hub (`/skills browse`). */
  readonly skillHubBrowse?: boolean;
  /** Hub search query (`/skills search <query>`). */
  readonly skillHubSearchQuery?: string;
  /** Hub install identifier (`/skills install <owner/repo[/path]>`). */
  readonly skillHubInstallId?: string;
  readonly localModelsPullModelId?: string;
  readonly localModelsUseModelId?: string;
  readonly triggerLocalModelsStatus?: boolean;
  /**
   * Theme name the caller should activate via `setActiveTheme` before
   * dispatching the `theme_set` re-render action (`/theme <name>`).
   */
  readonly setThemeName?: string;
  /**
   * `/telegram <verb>` side-effect requested by the user. Each verb
   * maps to a single orchestrator method; the caller (submit-handler)
   * dispatches by switch.
   */
  readonly telegramVerb?:
    | "enable"
    | "disable"
    | "start"
    | "stop"
    | "restart"
    | "pair"
    | "token"
    | "clear-token"
    | "clear-owner";
  /**
   * `/analytics <verb>` (or `/privacy analytics <verb>`) side-effect.
   * `enable` / `disable` toggle the opt-out; `status` just re-reads the
   * persisted flag into the UI. The caller (submit-handler) maps this to
   * the privacy orchestrator.
   */
  readonly analyticsVerb?: "enable" | "disable" | "status";
  /**
   * `/queue` side-effect. `list` renders the parked messages into chat —
   * the listing needs `TuiState`, which this pure dispatcher does not
   * have, so the caller formats it. `clear` additionally asks the
   * orchestrator to drop its own copy of the queue.
   */
  readonly queueVerb?: "list" | "clear";
  /**
   * `/steer <msg>` or `/queue <msg>`: land this one message in the given
   * mode without touching the persisted default. Ignored when no turn is
   * running (the caller submits it normally instead).
   */
  readonly submitWhileBusy?: { mode: WhileBusySubmitMode; text: string };
  /**
   * Bare `/steer` / `/queue`: the new Enter-while-busy default. The
   * `while_busy_mode_changed` action flips the live state; this asks the
   * caller to also write it to `tui.whileBusySubmit` through
   * `onWhileBusyModePersistRequested` — the same callback Ctrl+T uses, so
   * every route to the setting shares one persist path. Deliberately
   * unset by the message-carrying form, which is a one-off.
   */
  readonly setWhileBusyMode?: WhileBusySubmitMode;
  /**
   * `/mouse [on|off]` — flip terminal mouse reporting at runtime, or
   * report the current state with no argument. The caller owns the
   * escape sequences and the config write, because both live outside
   * React (see `tui-command.ts`).
   */
  readonly mouseVerb?: "on" | "off" | "status";
  /** `/max_steps [number]` — report or replace the active per-turn step budget. */
  readonly maxStepsRequest?:
    | { readonly kind: "status" }
    | { readonly kind: "set"; readonly value: number };
  /**
   * `/uninstall`: measure the install and feed the result back as
   * `uninstall_plan_loaded`. Nothing is removed on this path — the
   * dialog it opens is what eventually asks for that.
   */
  readonly triggerUninstallPlan?: boolean;
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
      triggerNewWindow: false,
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
      triggerNewWindow: false,
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
    case "mouse":
      return dispatchMouseSub(parsed.args);
    case "theme":
      return dispatchThemeSub(parsed.args);
    case "mode":
      return dispatchModeSub(parsed.args);
    case "clear":
      return pureActions([{ type: "chat_cleared" }], {
        systemMessage: "chat cleared",
      });
    case "queue":
      return dispatchQueueSub(parsed.args);
    case "steer":
      return dispatchSteerSub(parsed.args);
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
    case "uninstall":
      // Opens the ladder; it does not uninstall anything. The dialog
      // owns every decision from here, and the caller measures the disk
      // so the first screen can say what it costs.
      return pureActions([{ type: "uninstall_opened" }], {
        triggerUninstallPlan: true,
      });
    case "debug":
      return pureActions([{ type: "ui_mode_toggled" }]);
    case "context":
      return pureActions([{ type: "context_panel_toggled" }]);
    case "chat":
      return pureActions([{ type: "ui_mode_set", mode: "chat" }]);
    case "observe":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "feed" },
      ]);
    case "manage":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "tasks" },
      ]);
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
    case "window":
      return pureActions([], { triggerNewWindow: true });
    case "sidebar":
      // Pure state, so no trigger flag: the toggle rides `actions` the
      // way `/expand` and `/collapse` do, and the keyboard gets the
      // same flip the rail's « control gives the mouse.
      return pureActions([{ type: "sidebar_collapse_toggled" }]);
    case "tools":
      return dispatchToolsSub(parsed.args);
    case "skills":
      return dispatchSkillsSub(parsed.args);
    case "skill":
      return dispatchSkillSub(parsed.args);
    case "memory":
      return dispatchMemorySub(parsed.args);
    case "mcp":
      return dispatchMcpSub(parsed.args);
    case "llm":
      return dispatchLlmSub(parsed.args);
    case "model":
      return dispatchModelsSub(parsed.args, parsed.name);
    case "max_steps":
      return dispatchMaxStepsSub(parsed.args);
    case "tasks":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "tasks" },
      ]);
    case "task":
      return dispatchTaskSub(parsed.args);
    case "telegram":
      return dispatchTelegramSub(parsed.args);
    case "import":
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "import" },
      ]);
    case "privacy":
      return dispatchPrivacySub(parsed.args);
    case "analytics":
      return dispatchAnalyticsSub(parsed.args);
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

/**
 * `/queue` — bare switches the Enter-while-busy mode to `queue`, persists
 * it, and lists what is currently parked; `clear` (alias `drop`) empties
 * it; anything else is a one-off message to park without changing the
 * mode. The `queue_changed` action is dispatched optimistically so the
 * strip above the prompt disappears immediately;
 * `ChatOrchestrator.clearQueue` then re-publishes the authoritative empty
 * queue.
 */
function dispatchQueueSub(args: string): SlashDispatchResult {
  const raw = args.trim();
  const verb = raw.toLowerCase();
  if (verb === "clear" || verb === "drop") {
    return pureActions([{ type: "queue_changed", queued: [] }], {
      queueVerb: "clear",
    });
  }
  if (verb === "mode" || verb === "default") {
    return pureActions([{ type: "while_busy_mode_changed", mode: "queue" }], {
      setWhileBusyMode: "queue",
      systemMessage: "Enter now queues behind the running turn",
    });
  }
  if (raw.length > 0) {
    return pureActions([], {
      submitWhileBusy: { mode: "queue", text: raw },
    });
  }
  // Bare `/queue` stays a side-effect-free listing: the menu node and
  // the `/queue N parked` chip both invite running it just to look, so
  // looking must not silently persist a mode change.
  return pureActions([], { queueVerb: "list" });
}

/**
 * `/steer` — bare switches the Enter-while-busy mode to `steer` and
 * persists it; `/steer <message>` lands one message in the running turn
 * without changing the persisted default.
 */
function dispatchSteerSub(args: string): SlashDispatchResult {
  const raw = args.trim();
  if (raw.length > 0) {
    return pureActions([], {
      submitWhileBusy: { mode: "steer", text: raw },
    });
  }
  return pureActions([{ type: "while_busy_mode_changed", mode: "steer" }], {
    setWhileBusyMode: "steer",
    systemMessage:
      "Enter now steers the running turn (Ctrl+T or /queue switches back)",
  });
}

/**
 * `/mode` opens the menu; `/mode <name>` sets one directly, which is the
 * one path that skips it — a name typed in full is already a decision,
 * and making it open a menu to confirm what it just said would be a
 * second question about a settled matter. Names are matched on the
 * chip's own label as well as the identifier, because the label is what
 * the operator can see and being told the visible name is wrong would
 * be absurd.
 *
 * `accept-edits` still resolves to `auto`: it was the name this mode
 * shipped under, and a rename is not a reason to reject a word somebody
 * already learned.
 */
function dispatchModeSub(args: string): SlashDispatchResult {
  const raw = args.trim().toLowerCase();
  if (raw.length === 0) {
    // Bare `/mode` opens the menu rather than advancing the ring, so
    // every route to this control — the chip, the chord, the command —
    // ends at the same four rows with the same four explanations.
    return pureActions([{ type: "coding_mode_menu_opened" }]);
  }
  const wanted = raw.replace(/[\s_]+/g, "-");
  const RETIRED_NAMES: Readonly<Record<string, CodingMode>> = {
    "accept-edits": "auto",
  };
  const match =
    CODING_MODES.find(
      (mode) =>
        mode === wanted ||
        codingModeLook(mode).label.replace(/\s+/g, "-") === wanted,
    ) ?? RETIRED_NAMES[wanted];
  if (!match) {
    return pureActions([], {
      systemMessage: `unknown mode: ${args.trim()} — try ${CODING_MODES.join(", ")}`,
    });
  }
  return pureActions([{ type: "coding_mode_cycled", mode: match }]);
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
    triggerNewWindow: false,
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
    setThemeName: undefined,
    telegramVerb: undefined,
    analyticsVerb: undefined,
    queueVerb: undefined,
    submitWhileBusy: undefined,
    setWhileBusyMode: undefined,
    ...overrides,
  };
}

/**
 * Sub-dispatcher for `/theme [name|list]`. Bare `/theme` opens the
 * interactive picker (arrow-key live preview, Enter applies). `/theme list`
 * prints the available names into the chat. `/theme <name>` validates against
 * the registry and, on success, asks the caller to swap + persist + re-render.
 * Unknown names surface a usage hint instead of switching.
 */
/**
 * `/mouse` with no argument reports state; `on` / `off` set it. Any
 * other word is rejected rather than guessed at — a typo'd `/mouse ff`
 * silently disabling clicks would be a maddening bug to chase.
 */
function dispatchMouseSub(rawArgs: string): SlashDispatchResult {
  const verb = rawArgs.trim().toLowerCase();
  if (verb.length === 0) return pureActions([], { mouseVerb: "status" });
  if (verb === "on" || verb === "enable") {
    return pureActions([], { mouseVerb: "on" });
  }
  if (verb === "off" || verb === "disable") {
    return pureActions([], { mouseVerb: "off" });
  }
  return pureActions([], {
    systemMessage: `usage: /mouse [on|off] (got "${rawArgs.trim()}")`,
  });
}

function dispatchThemeSub(rawArgs: string): SlashDispatchResult {
  const arg = rawArgs.trim().toLowerCase();
  if (arg.length === 0) {
    return pureActions([{ type: "theme_picker_opened" }]);
  }
  if (arg === "list") {
    return pureActions([], {
      systemMessage: `available themes:\n  ${THEME_NAMES.join("\n  ")}`,
    });
  }
  if (!isThemeName(arg)) {
    return pureActions([], {
      systemMessage: `unknown theme: ${arg}\navailable: ${THEME_NAMES.join(", ")}`,
    });
  }
  return pureActions([{ type: "theme_set", name: arg }], {
    setThemeName: arg,
    systemMessage: `theme set to ${arg}`,
  });
}

/**
 * Sub-dispatcher for `/model [verb] [args]` (aliases: `/models`,
 * `/local`). `/model` and `/models` used to be separate commands that
 * only differed in bare behavior (tab jump + picker request vs tab jump
 * + route sync), which read as two commands opening the same window;
 * the two were merged under the singular name (the industry-standard
 * spelling) so either lands in one place. Accepted shapes:
 *   - (bare)        — open the LLM tab on the active local/cloud route,
 *                     focus the inline model list's `filter:` row and
 *                     ensure the catalog is loaded (#62). On a local
 *                     route the focus action no-ops (the reducer flips
 *                     the pane to cloud only for explicit `f`), leaving
 *                     the tab switch as the whole effect there.
 *                     `/local` pins the local pane and skips the list.
 *   - `pull <id>`   — open the tab and kick off a pull for the given id.
 *   - `use <id>`    — open the tab and set the given id as active.
 *   - `status`      — emit the managed-runtime status line in the feed.
 *   - `<base-url>`  — persist the base URL for external mode (back-compat).
 */
function dispatchModelsSub(rawArgs: string, commandName: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  const bits = argPart.split(/\s+/).filter(Boolean);
  if (argPart.length === 0) {
    if (commandName === "local") {
      return pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "llm" },
        { type: "llm_mode_set", mode: "local" },
      ]);
    }
    // The inline model list replaces the modal picker in the Cloud pane:
    // jump to the active route, focus the `filter:` row and ensure the
    // catalog is loaded. The ensure request is intercepted by
    // submit-handler and routed through the orchestrator callback — a
    // dispatched reducer action never reaches the bus the orchestrator
    // listens on.
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set_to_active_route" },
      { type: "llm_cloud_filter_focus_set", focused: true },
      { type: "providers_inline_models_ensure_requested", providerId: null },
    ]);
  }
  if (bits[0] === "pull" && bits[1]) {
    return {
      ...pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "llm" },
        { type: "llm_focus_set", focus: "local" },
      ]),
      localModelsPullModelId: bits[1],
    };
  }
  if (bits[0] === "use" && bits[1]) {
    return {
      ...pureActions([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "llm" },
        { type: "llm_focus_set", focus: "local" },
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
        "usage: /model | /model pull <id> | /model use <id> | /model status | /model <base-url>",
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
function dispatchMemorySub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "memory" },
      {
        type: "memory_refresh_requested",
        channel: "profile",
        notesArchiveFilter: "active",
        searchQuery: "",
      },
    ]);
  }
  if (argPart.toLowerCase() === "dump") {
    return pureActions([], { triggerMemoryDump: true });
  }
  return pureActions([], {
    systemMessage: "usage: /memory | /memory dump",
  });
}

function dispatchMcpSub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "mcp" },
      { type: "mcp_refresh_requested" },
    ]);
  }
  if (argPart.toLowerCase() === "add") {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "mcp" },
      { type: "mcp_add_modal_opened" },
    ]);
  }
  const removeMatch = argPart.match(/^remove\s+(\S+)\s*$/i);
  if (removeMatch) {
    const name = removeMatch[1]!;
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "mcp" },
      { type: "mcp_remove_confirm_opened", name },
    ]);
  }
  return pureActions([], {
    systemMessage: "usage: /mcp | /mcp add | /mcp remove <name>",
  });
}

function dispatchLlmSub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "providers_refresh_requested" },
    ]);
  }
  const providerMatch = argPart.match(/^provider\s+(\S+)\s*$/i);
  if (providerMatch) {
    const id = providerMatch[1]!;
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_focus_set", focus: "cloud" },
      { type: "providers_set_active_text", id },
    ]);
  }
  // `/llm fallback` deep-links to the fourth pane — the pane switcher
  // (`[`/`]`) is invisible from the chat surface, so without this the
  // Fallback pane is only reachable by keyboard exploration. The refresh
  // matches bare `/llm`: the slash path enters the tab via reducer
  // actions, bypassing `onProvidersTabRefresh`, so without it the chain
  // mirror shows whatever the last refresh produced (stale if config
  // changed externally mid-session).
  if (/^fallback$/i.test(argPart)) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set", mode: "fallback" },
      { type: "providers_refresh_requested" },
    ]);
  }
  // `/llm check` exercises the real turn contract against the active
  // provider — streaming, tools payload, a forced native tool call —
  // and reports what came back. A reachable `/v1/models` says nothing
  // about any of that, so until now the first real message was the
  // test. Explicit only: it spends requests against the operator's own
  // account and must never run on a turn path.
  if (/^check$/i.test(argPart)) {
    return pureActions([{ type: "providers_contract_probe_requested", providerId: null }], {
      systemMessage:
        "checking the active provider's streaming tool-call contract — this sends one request",
    });
  }
  return pureActions([], {
    systemMessage: "usage: /llm | /llm provider <id> | /llm check | /llm fallback",
  });
}

/**
 * `/tools` answers "what can this agent actually do" without touching a
 * panel: the listing is pure text, filtered through the same config
 * gates the runtime applies so disabled families never show up.
 * Users used to search /skills for "filesystem", find nothing, and
 * conclude the agent could not touch files (#71).
 */
function dispatchToolsSub(rawArgs: string): SlashDispatchResult {
  const query = rawArgs.trim();
  return pureActions([], {
    systemMessage:
      query.length === 0 ? renderToolsOverview() : renderToolsSearch(query),
  });
}

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
  const [verb, ...rest] = argPart.split(/\s+/);
  const verbLower = (verb ?? "").toLowerCase();
  const openSkillsTab: TuiAction[] = [
    { type: "ui_mode_set", mode: "debug" },
    { type: "tab_changed", tab: "skills" },
  ];
  if (verbLower === "browse") {
    return pureActions(openSkillsTab, { skillHubBrowse: true });
  }
  if (verbLower === "search") {
    return pureActions(openSkillsTab, {
      skillHubSearchQuery: rest.join(" ").trim(),
    });
  }
  if (verbLower === "install") {
    const id = rest.join(" ").trim();
    if (id.length === 0) {
      return pureActions([], {
        systemMessage: "usage: /skills install <owner/repo[/path]>",
      });
    }
    return pureActions(openSkillsTab, { skillHubInstallId: id });
  }
  return pureActions([], {
    systemMessage:
      "usage: /skills | /skills dump | /skills browse | /skills search <q> | /skills install <id>",
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

/**
 * Sub-dispatcher for `/telegram [verb]`. Bare `/telegram` opens the
 * Telegram tab. Verbs (`enable | disable | start | stop | restart |
 * pair | token | clear-token | clear-owner`) are forwarded to the
 * orchestrator as side-effect flags. The token verb just opens the
 * masked prompt — slash commands never accept a token argument so the
 * value never lands in shell history.
 */
function dispatchTelegramSub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "telegram" },
    ]);
  }
  const verb = argPart.split(/\s+/)[0]?.toLowerCase() ?? "";
  switch (verb) {
    case "enable":
    case "disable":
    case "start":
    case "stop":
    case "restart":
    case "pair":
    case "token":
    case "clear-token":
    case "clear-owner":
      return {
        ...pureActions([
          { type: "ui_mode_set", mode: "debug" },
          { type: "tab_changed", tab: "telegram" },
        ]),
        telegramVerb: verb,
      };
    default:
      return pureActions([], {
        systemMessage:
          "usage: /telegram | /telegram enable | disable | start | stop | restart | pair | token | clear-token | clear-owner",
      });
  }
}

/**
 * Sub-dispatcher for `/privacy [analytics <verb>]`. Bare `/privacy`
 * opens the Privacy tab. `/privacy analytics on|off|status` forwards to
 * the same analytics side-effect as the top-level `/analytics` command.
 * The old `/privacy level` / `/privacy approve` surface is gone: the
 * approval stance is the coding-mode control in the composer now.
 */
function dispatchPrivacySub(rawArgs: string): SlashDispatchResult {
  const argPart = rawArgs.trim();
  if (argPart.length === 0) {
    return pureActions([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "privacy" },
    ]);
  }
  const bits = argPart.split(/\s+/);
  if ((bits[0] ?? "").toLowerCase() === "analytics") {
    return dispatchAnalyticsSub(bits.slice(1).join(" "));
  }
  return pureActions([], {
    systemMessage: "usage: /privacy | /privacy analytics on|off|status",
  });
}

/**
 * Sub-dispatcher for `/analytics <verb>`. Maps `on`/`enable`,
 * `off`/`disable`, and `status` onto `analyticsVerb`. Every verb also
 * opens the Privacy tab so the effect is visible.
 */
function dispatchAnalyticsSub(rawArgs: string): SlashDispatchResult {
  const verb = rawArgs.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const openPrivacyTab: TuiAction[] = [
    { type: "ui_mode_set", mode: "debug" },
    { type: "tab_changed", tab: "privacy" },
  ];
  if (verb === "on" || verb === "enable") {
    return pureActions(openPrivacyTab, { analyticsVerb: "enable" });
  }
  if (verb === "off" || verb === "disable") {
    return pureActions(openPrivacyTab, { analyticsVerb: "disable" });
  }
  if (verb === "status") {
    return pureActions(openPrivacyTab, { analyticsVerb: "status" });
  }
  return pureActions([], {
    systemMessage: "usage: /analytics on | off | status",
  });
}

/**
 * Sub-dispatcher for `/max_steps [number]`. Bare `/max_steps` shows the
 * current value. `/max_steps <number>` sets a new positive integer value.
 */
function dispatchMaxStepsSub(rawArgs: string): SlashDispatchResult {
  const args = rawArgs.trim();
  if (args.length === 0) {
    return pureActions([], {
      maxStepsRequest: { kind: "status" },
    });
  }

  let newValue: number;
  try {
    newValue = parsePositiveInt(args, "max_steps");
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      return pureActions([], {
        systemMessage: err.message,
      });
    }
    return pureActions([], {
      systemMessage: `invalid max_steps value: ${args}`,
    });
  }
  return pureActions([], {
    maxStepsRequest: { kind: "set", value: newValue },
  });
}
