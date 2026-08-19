import type { TuiSection } from "../section.js";
import type { TuiTab } from "../tui-state.js";

/**
 * Top-level grouping of the operator menu. `go` holds destinations and
 * deliberately mirrors the product's own Run / Observe / Manage split
 * rather than inventing a second taxonomy for the same rooms; the rest
 * are verbs grouped by *what they act on* — the thread, the model, the
 * turn in flight, the configuration — which is the only grouping that
 * stays true as entries are added.
 */
export type MenuGroup =
  | "go"
  | "session"
  | "model"
  | "run"
  | "setup"
  | "help";

/** Display order of the groups in the menu. */
export const MENU_GROUP_ORDER: readonly MenuGroup[] = [
  "go",
  "session",
  "model",
  "run",
  "setup",
  "help",
];

export const MENU_GROUP_LABELS: Record<MenuGroup, string> = {
  go: "Go",
  session: "Session",
  model: "Model",
  run: "Run",
  setup: "Setup",
  help: "Help",
};

/**
 * The slash command a node is also reachable as. A node that carries one
 * is *activated* by running that command, so the menu never grows a
 * second dispatch path alongside `slash-command-handler.ts`.
 */
export interface MenuSlash {
  readonly name: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  /**
   * Position in the slash palette listing. Kept explicit because the
   * palette order is user-visible (empty query lists the registry in
   * order, and ties in a fuzzy search break by index) and is not the
   * same as the menu's own order.
   */
  readonly rank: number;
}

interface MenuNodeBase {
  /** Stable identifier, e.g. `go.manage.tasks`. Never shown to the operator. */
  readonly id: string;
  readonly label: string;
  readonly group: MenuGroup;
  /**
   * Single key pressed after the `ctrl+g` leader. Unique across the whole
   * registry — `menu-registry.test.ts` fails the build if two nodes claim
   * the same one.
   */
  readonly chord?: string;
  readonly slash?: MenuSlash;
  /** Parent submenu id, for nodes one level down. */
  readonly parent?: string;
}

/** A destination: a section, or a tab inside one. */
export interface MenuPlaceNode extends MenuNodeBase {
  readonly kind: "place";
  readonly section: TuiSection;
  readonly tab?: TuiTab;
}

/** A one-level-deep grouping of places. The tree never goes deeper. */
export interface MenuSubmenuNode extends MenuNodeBase {
  readonly kind: "submenu";
}

/** A verb. Activating it runs `slash.name` through the existing handler. */
export interface MenuActionNode extends MenuNodeBase {
  readonly kind: "action";
}

export type MenuNode = MenuPlaceNode | MenuSubmenuNode | MenuActionNode;

/**
 * The single source of truth for the operator menu, the slash palette and
 * the `ctrl+g` chord table. Everything that used to be a hand-kept
 * parallel list is now a projection of this array — see
 * `toSlashCommands()` below and `slash-commands.ts`.
 */
export const MENU: readonly MenuNode[] = [
  {
    kind: "place",
    id: "go.run",
    label: "Run",
    group: "go",
    chord: "r",
    slash: {
      name: "chat",
      description:
        "return to single-view chat mode",
      aliases: ["run"],
      rank: 8,
    },
    section: "run",
  },
  {
    kind: "action",
    id: "go.debug",
    label: "Toggle debug pane",
    group: "go",
    slash: {
      name: "debug",
      description:
        "toggle debug pane (feed / logs / world …)",
      rank: 7,
    },
  },
  {
    kind: "submenu",
    id: "go.observe",
    label: "Observe",
    group: "go",
    slash: {
      name: "observe",
      description:
        "switch to the Observe section (feed / world / reasoning / logs / llm-logs)",
      rank: 9,
    },
  },
  {
    kind: "place",
    id: "go.observe.feed",
    label: "Feed",
    group: "go",
    chord: "f",
    slash: {
      name: "feed",
      description:
        "jump to the Observe → Feed tab",
      rank: 11,
    },
    section: "observe",
    tab: "feed",
    parent: "go.observe",
  },
  {
    kind: "place",
    id: "go.observe.world",
    label: "World",
    group: "go",
    chord: "w",
    slash: {
      name: "world",
      description:
        "jump to the Observe → World tab",
      rank: 14,
    },
    section: "observe",
    tab: "world",
    parent: "go.observe",
  },
  {
    kind: "place",
    id: "go.observe.reasoning",
    label: "Reasoning",
    group: "go",
    chord: "e",
    slash: {
      name: "reasoning",
      description:
        "jump to the Observe → Reasoning tab",
      rank: 13,
    },
    section: "observe",
    tab: "reasoning",
    parent: "go.observe",
  },
  {
    kind: "place",
    id: "go.observe.logs",
    label: "Logs",
    group: "go",
    chord: "o",
    slash: {
      name: "logs",
      description:
        "jump to the Observe → Logs tab",
      rank: 12,
    },
    section: "observe",
    tab: "logs",
    parent: "go.observe",
  },
  {
    kind: "place",
    id: "go.observe.llm-logs",
    label: "LLM logs",
    group: "go",
    chord: "L",
    section: "observe",
    tab: "llm-logs",
    parent: "go.observe",
  },
  {
    kind: "submenu",
    id: "go.manage",
    label: "Manage",
    group: "go",
    slash: {
      name: "manage",
      description:
        "switch to the Manage section (tasks / skills / LLM / telegram)",
      rank: 10,
    },
  },
  {
    kind: "place",
    id: "go.manage.tasks",
    label: "Tasks",
    group: "go",
    chord: "t",
    slash: {
      name: "tasks",
      description:
        "jump to the Tasks tab (Option 4 cron + ingress UI)",
      rank: 26,
    },
    section: "manage",
    tab: "tasks",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.skills",
    label: "Skills",
    group: "go",
    chord: "s",
    slash: {
      name: "skills",
      description:
        "jump to the Skills tab · subcommand: `/skills dump` to print catalog in chat",
      rank: 20,
    },
    section: "manage",
    tab: "skills",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.memory",
    label: "Memory",
    group: "go",
    chord: "m",
    slash: {
      name: "memory",
      description:
        "open Memory tab (profile, notes, lessons, …) · subcommand: `/memory dump` for profile in chat",
      rank: 22,
    },
    section: "manage",
    tab: "memory",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.mcp",
    label: "MCP",
    group: "go",
    chord: "c",
    slash: {
      name: "mcp",
      description:
        "open MCP tab (configured servers + discovered tools / resources / prompts) · subcommands: `/mcp add` opens JSON-paste modal, `/mcp remove <name>` opens delete-confirm",
      rank: 24,
    },
    section: "manage",
    tab: "mcp",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.llm",
    label: "LLM",
    group: "go",
    chord: "l",
    slash: {
      name: "llm",
      description:
        "open LLM Local/Cloud/External panel · `/llm provider <id>` switch text provider",
      rank: 23,
    },
    section: "manage",
    tab: "llm",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.telegram",
    label: "Telegram",
    group: "go",
    chord: "g",
    slash: {
      name: "telegram",
      description:
        "telegram tab · subcommands: enable | disable | start | stop | restart | pair | token",
      rank: 28,
    },
    section: "manage",
    tab: "telegram",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.import",
    label: "Import",
    group: "go",
    chord: "i",
    slash: {
      name: "import",
      description:
        "open the Import tab (one-shot Hermes -> atomic-agent migration)",
      rank: 29,
    },
    section: "manage",
    tab: "import",
    parent: "go.manage",
  },
  {
    kind: "place",
    id: "go.manage.privacy",
    label: "Privacy",
    group: "go",
    chord: "p",
    slash: {
      name: "privacy",
      description:
        "open the Privacy tab (analytics opt-out + approval level) · subcommands: `/privacy analytics on|off` | `/privacy level 1..5` | `/privacy approve on|off`",
      rank: 30,
    },
    section: "manage",
    tab: "privacy",
    parent: "go.manage",
  },
  {
    kind: "action",
    id: "session.new",
    label: "New session",
    group: "session",
    chord: "n",
    slash: {
      name: "new",
      description:
        "start a fresh session (keeps warm runtime)",
      rank: 19,
    },
  },
  {
    kind: "action",
    id: "session.switch",
    label: "Switch session…",
    group: "session",
    chord: "u",
    slash: {
      name: "sessions",
      description:
        "open session picker to switch threads",
      rank: 18,
    },
  },
  {
    kind: "action",
    id: "session.clear",
    label: "Clear transcript",
    group: "session",
    slash: {
      name: "clear",
      description:
        "clear chat transcript (keeps session)",
      rank: 4,
    },
  },
  {
    kind: "action",
    id: "session.id",
    label: "Show session id",
    group: "session",
    slash: {
      name: "session",
      description:
        "show current session id",
      rank: 17,
    },
  },
  {
    kind: "action",
    id: "model.chat",
    label: "Switch chat model…",
    group: "model",
    chord: "k",
    slash: {
      name: "model",
      description:
        "open chat model picker · subcommands: pull <id> | use <id> | status | <base-url>",
      aliases: ["models", "local"],
      rank: 25,
    },
  },
  {
    kind: "action",
    id: "run.abort",
    label: "Abort turn",
    group: "run",
    chord: "a",
    slash: {
      name: "abort",
      description:
        "abort the running turn",
      rank: 5,
    },
  },
  {
    kind: "action",
    id: "run.expand",
    label: "Expand all tool cards",
    group: "run",
    slash: {
      name: "expand",
      description:
        "expand every tool card in the chat log",
      rank: 15,
    },
  },
  {
    kind: "action",
    id: "run.collapse",
    label: "Collapse all tool cards",
    group: "run",
    slash: {
      name: "collapse",
      description:
        "collapse every tool card in the chat log",
      rank: 16,
    },
  },
  {
    kind: "action",
    id: "setup.theme",
    label: "Theme…",
    group: "setup",
    chord: "h",
    slash: {
      name: "theme",
      description:
        "switch the UI theme: `/theme <name>` | `/theme list` (github, catppuccin, dracula, nord, …)",
      rank: 3,
    },
  },
  {
    kind: "action",
    id: "setup.analytics",
    label: "Analytics",
    group: "setup",
    slash: {
      name: "analytics",
      description:
        "toggle anonymous analytics: `/analytics on|off|status`",
      rank: 31,
    },
  },
  {
    kind: "action",
    id: "setup.skill",
    label: "Enable or disable a skill…",
    group: "setup",
    slash: {
      name: "skill",
      description:
        "skill subcommand: `/skill enable <name>` | `/skill disable <name>`",
      rank: 21,
    },
  },
  {
    kind: "action",
    id: "setup.task",
    label: "Create, cancel or run a task…",
    group: "setup",
    slash: {
      name: "task",
      description:
        "task subcommand: `/task new` | `/task cancel <id>` | `/task run <id>`",
      rank: 27,
    },
  },
  {
    kind: "action",
    id: "help.commands",
    label: "Commands",
    group: "help",
    slash: {
      name: "help",
      description:
        "list available slash commands",
      rank: 1,
    },
  },
  {
    kind: "action",
    id: "help.tools",
    label: "List built-in tools",
    group: "help",
    slash: {
      name: "tools",
      description:
        "list built-in tools (fs, shell, browser, memory, vision): `/tools` | `/tools <query>`",
      rank: 2,
    },
  },
  {
    kind: "action",
    id: "help.dump",
    label: "Write debug bundle",
    group: "help",
    chord: "d",
    slash: {
      name: "dump",
      description:
        "write debug zip (TUI snapshot + recent trace NDJSON) to ~/Documents/atomic-agent-debug",
      rank: 0,
    },
  },
  {
    kind: "action",
    id: "help.quit",
    label: "Quit",
    group: "help",
    chord: "q",
    slash: {
      name: "quit",
      description:
        "exit atomic-agent",
      aliases: ["exit"],
      rank: 6,
    },
  },
];

/** Every node that is also a slash command, in palette order. */
export function toSlashCommands(): readonly MenuSlash[] {
  return MENU.flatMap((node) => (node.slash ? [node.slash] : [])).sort(
    (a, b) => a.rank - b.rank,
  );
}

/** Children of a submenu, in registry order. */
export function menuChildren(parentId: string): readonly MenuNode[] {
  return MENU.filter((node) => node.parent === parentId);
}

/** Top-level nodes of a group — submenu children are excluded. */
export function menuRoots(group: MenuGroup): readonly MenuNode[] {
  return MENU.filter((node) => node.group === group && node.parent === undefined);
}

/** Resolve a node by id. */
export function menuNodeById(id: string): MenuNode | null {
  return MENU.find((node) => node.id === id) ?? null;
}

/** Resolve the node bound to a `ctrl+g` chord key. */
export function menuNodeByChord(key: string): MenuNode | null {
  return MENU.find((node) => node.chord === key) ?? null;
}
