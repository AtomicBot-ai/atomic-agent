import type { TuiAction } from "../tui-action.js";
import { normalizeLocalLlmBaseUrl } from "../persist-user-local-models-config.js";
import { isThemeName, THEME_NAMES } from "../theme/theme.js";
import { parseSlashCommand } from "./slash-command-parser.js";
import { resolveSlashCommand, SLASH_COMMANDS } from "./slash-commands.js";
import { renderToolsOverview, renderToolsSearch } from "./tools-listing.js";
import { getConfig } from "../../config/index.js";
import { parsePositiveInt } from "../../config/config-schema.js";
import { ConfigValidationError } from "../../config/config-validation-error.js";
import {
  getUserConfigPath,
  ensureUserConfigFileSync,
  writeUserConfigFileSync,
} from "../../config/config-file.js";

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
   * `/privacy level <1..5>` side-effect (with `/privacy approve on|off`
   * kept as aliases for 5 and 1): move the approval ladder to an
   * explicit level. The caller (submit-handler) maps this to
   * `PrivacyOrchestrator.setApprovalLevel`.
   */
  readonly approvalLevelSet?: number;
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
    case "theme":
      return dispatchThemeSub(parsed.args);
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
    setThemeName: undefined,
    telegramVerb: undefined,
    analyticsVerb: undefined,
    approvalLevelSet: undefined,
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
  return pureActions([], {
    systemMessage: "usage: /llm | /llm provider <id>",
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
 * Sub-dispatcher for `/privacy [analytics <verb> | level <1..5> |
 * approve <on|off>]`. Bare `/privacy` opens the Privacy tab. `/privacy
 * analytics on|off|status` forwards to the same analytics side-effect
 * as the top-level `/analytics` command. `/privacy level 1..5` moves
 * the approval ladder; `/privacy approve on|off` stays as the
 * backward-compatible alias pair for levels 5 and 1.
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
  if ((bits[0] ?? "").toLowerCase() === "level") {
    return dispatchApprovalLevelSub(bits.slice(1).join(" "));
  }
  if ((bits[0] ?? "").toLowerCase() === "approve") {
    return dispatchApproveSub(bits.slice(1).join(" "));
  }
  return pureActions([], {
    systemMessage:
      "usage: /privacy | /privacy analytics on|off|status | /privacy level 1..5 | /privacy approve on|off",
  });
}

/**
 * Sub-dispatcher for `/privacy level <1..5>`. Opens the Privacy tab so
 * the ladder's new position (and its coverage copy) is visible, then
 * asks the caller to run `setApprovalLevel`. Rejects anything but an
 * integer 1..5: the level names an exact trust boundary, so a typo must
 * not land on a guessed one.
 */
function dispatchApprovalLevelSub(rawArgs: string): SlashDispatchResult {
  const raw = rawArgs.trim().split(/\s+/)[0] ?? "";
  const level = Number.parseInt(raw, 10);
  if (!/^[1-5]$/.test(raw) || Number.isNaN(level)) {
    return pureActions([], {
      systemMessage: "usage: /privacy level 1 | 2 | 3 | 4 | 5",
    });
  }
  return pureActions(
    [
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "privacy" },
    ],
    { approvalLevelSet: level },
  );
}

/**
 * Sub-dispatcher for `/privacy approve <on|off>` — the pre-ladder
 * command surface, kept as aliases so muscle memory and scripts
 * survive: `on` maps to level 5 (approve everything), `off` to level 1
 * (ask for everything). No bare form: the verb is deliberately explicit
 * because `on` means "run everything without asking".
 */
function dispatchApproveSub(rawArgs: string): SlashDispatchResult {
  const verb = rawArgs.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const openPrivacyTab: TuiAction[] = [
    { type: "ui_mode_set", mode: "debug" },
    { type: "tab_changed", tab: "privacy" },
  ];
  if (verb === "on") {
    return pureActions(openPrivacyTab, { approvalLevelSet: 5 });
  }
  if (verb === "off") {
    return pureActions(openPrivacyTab, { approvalLevelSet: 1 });
  }
  return pureActions([], {
    systemMessage: "usage: /privacy approve on | off",
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
    // Show current value
    const current = getConfig().agent.maxSteps;
    return pureActions([], {
      systemMessage: `current max_steps: ${current}`,
    });
  }

  // Parse and validate the new value
  let newValue: number;
  try {
    // Reuse the same validation as in config-schema.ts
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

  // Update the runtime config
  const config = getConfig();
  const oldValue = config.agent.maxSteps;
  config.agent.maxSteps = newValue;

  // Persist to config.json
  try {
    const stateDir = getConfig().paths.stateDir;
    const userConfigPath = getUserConfigPath(stateDir);
    const userConfig = ensureUserConfigFileSync(userConfigPath);
    userConfig.agent.maxSteps = newValue;
    writeUserConfigFileSync(userConfigPath, userConfig);
  } catch (err) {
    // If we can't persist, return an error but still update runtime
    const message = err instanceof Error ? err.message : String(err);
    return pureActions([], {
      systemMessage: `max_steps updated to ${newValue} (runtime only - failed to persist: ${message})`,
    });
  }

  return pureActions([], {
    systemMessage: `max_steps updated from ${oldValue} to ${newValue}`,
  });
}
