import { describe, expect, it } from "vitest";

import { SLASH_COMMANDS } from "../commands/slash-commands.js";
import {
  MENU,
  MENU_GROUP_ORDER,
  menuChildren,
  menuNodeByChord,
  menuNodeById,
  menuRoots,
} from "./menu-registry.js";

/**
 * The slash palette exactly as it shipped in v0.2.2, before the registry
 * refactor. `SLASH_COMMANDS` is now derived from `MENU`; this snapshot is
 * what makes "no visible change" a claim the suite can check rather than
 * a promise in a PR description.
 *
 * Deliberate additions since v0.2.2 are appended here as they land, so the
 * guard keeps catching *accidental* drift: `/mouse` (the mouse layer) is
 * the only entry that was not in the v0.2.2 palette.
 */
const V0_2_2_SLASH_COMMANDS = [
  {
    name: "dump",
    description:
      "write debug zip (TUI snapshot + recent trace NDJSON) to ~/Documents/atomic-agent-debug",
  },
  {
    name: "help",
    description:
      "list available slash commands",
  },
  {
    name: "tools",
    description:
      "list built-in tools (fs, shell, browser, memory, vision): `/tools` | `/tools <query>`",
  },
  {
    name: "theme",
    description:
      "switch the UI theme: `/theme <name>` | `/theme list` (github, catppuccin, dracula, nord, …)",
  },
  {
    name: "clear",
    description:
      "clear chat transcript (keeps session)",
  },
  {
    name: "abort",
    description:
      "abort the running turn",
  },
  {
    name: "quit",
    description:
      "exit atomic-agent",
    aliases: ["exit"],
  },
  {
    name: "debug",
    description:
      "toggle debug pane (feed / logs / world …)",
  },
  {
    name: "chat",
    description:
      "return to single-view chat mode",
    aliases: ["run"],
  },
  {
    name: "observe",
    description:
      "switch to the Observe section (feed / world / reasoning / logs / llm-logs)",
  },
  {
    name: "manage",
    description:
      "switch to the Manage section (tasks / skills / LLM / telegram)",
  },
  {
    name: "feed",
    description:
      "jump to the Observe → Feed tab",
  },
  {
    name: "logs",
    description:
      "jump to the Observe → Logs tab",
  },
  {
    name: "reasoning",
    description:
      "jump to the Observe → Reasoning tab",
  },
  {
    name: "world",
    description:
      "jump to the Observe → World tab",
  },
  {
    name: "expand",
    description:
      "expand every tool card in the chat log",
  },
  {
    name: "collapse",
    description:
      "collapse every tool card in the chat log",
  },
  {
    name: "session",
    description:
      "show current session id",
  },
  {
    name: "sessions",
    description:
      "open session picker to switch threads",
  },
  {
    name: "new",
    description:
      "start a fresh session (keeps warm runtime)",
  },
  {
    name: "skills",
    description:
      "jump to the Skills tab · subcommand: `/skills dump` to print catalog in chat",
  },
  {
    name: "skill",
    description:
      "skill subcommand: `/skill enable <name>` | `/skill disable <name>`",
  },
  {
    name: "memory",
    description:
      "open Memory tab (profile, notes, lessons, …) · subcommand: `/memory dump` for profile in chat",
  },
  {
    name: "llm",
    description:
      "open LLM Local/Cloud/External panel · `/llm provider <id>` switch text provider",
  },
  {
    name: "mcp",
    description:
      "open MCP tab (configured servers + discovered tools / resources / prompts) · subcommands: `/mcp add` opens JSON-paste modal, `/mcp remove <name>` opens delete-confirm",
  },
  {
    name: "model",
    description:
      "open chat model picker · subcommands: pull <id> | use <id> | status | <base-url>",
    aliases: ["models", "local"],
  },
  {
    name: "tasks",
    description:
      "jump to the Tasks tab (Option 4 cron + ingress UI)",
  },
  {
    name: "task",
    description:
      "task subcommand: `/task new` | `/task cancel <id>` | `/task run <id>`",
  },
  {
    name: "telegram",
    description:
      "telegram tab · subcommands: enable | disable | start | stop | restart | pair | token",
  },
  {
    name: "import",
    description:
      "open the Import tab (one-shot Hermes -> atomic-agent migration)",
  },
  {
    name: "privacy",
    description:
      "open the Privacy tab (analytics opt-out + approval level) · subcommands: `/privacy analytics on|off` | `/privacy level 1..5` | `/privacy approve on|off`",
  },
  {
    name: "analytics",
    description:
      "toggle anonymous analytics: `/analytics on|off|status`",
  },
  // Added after v0.2.2: the mid-run message queue (#156) and steering (#159).
  {
    name: "queue",
    description:
      "parked messages: `/queue` list | `/queue <msg>` park one | `/queue clear` | `/queue mode` make Enter queue",
  },
  {
    name: "steer",
    description:
      "steer the running turn: `/steer <msg>` one-shot | bare `/steer` makes Enter steer",
  },
  {
    name: "window",
    description:
      "open a new terminal window running atomic-agent (ctrl+n)",
    aliases: ["newwindow"],
  },
  {
    name: "mouse",
    description:
      "mouse support on/off/status (off restores the terminal's drag-to-select)",
  },
  // Added after v0.3.2: uninstall (#135).
  {
    name: "uninstall",
    description:
      "remove Atomic Agent from this machine (state directory kept unless you opt in)",
  },
];

describe("menu registry", () => {
  it("derives the slash palette from the registry — same commands, same order", () => {
    expect(SLASH_COMMANDS).toEqual(V0_2_2_SLASH_COMMANDS);
  });

  it("gives every node a unique id", () => {
    const ids = MENU.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never lets two nodes claim the same ctrl+g chord", () => {
    const chords = MENU.flatMap((node) => (node.chord ? [node.chord] : []));
    expect(chords.length).toBeGreaterThan(0);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("never lets two nodes claim the same slash name or alias", () => {
    const names = MENU.flatMap((node) =>
      node.slash ? [node.slash.name, ...(node.slash.aliases ?? [])] : [],
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every slash command a distinct palette rank", () => {
    const ranks = MENU.flatMap((node) => (node.slash ? [node.slash.rank] : []));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("points every parent at a real submenu", () => {
    for (const node of MENU) {
      if (node.parent === undefined) continue;
      const parent = menuNodeById(node.parent);
      expect(parent, `${node.id} -> ${node.parent}`).not.toBeNull();
      expect(parent?.kind).toBe("submenu");
    }
  });

  it("keeps the tree exactly one level deep", () => {
    for (const node of MENU) {
      if (node.parent === undefined) continue;
      const parent = menuNodeById(node.parent);
      expect(parent?.parent).toBeUndefined();
    }
  });

  it("leaves no submenu empty", () => {
    for (const node of MENU) {
      if (node.kind !== "submenu") continue;
      expect(menuChildren(node.id).length, node.id).toBeGreaterThan(0);
    }
  });

  it("puts every node in a group the menu knows how to render", () => {
    for (const node of MENU) {
      expect(MENU_GROUP_ORDER).toContain(node.group);
    }
  });

  it("resolves places by chord", () => {
    expect(menuNodeByChord("t")?.id).toBe("go.manage.tasks");
    expect(menuNodeByChord("p")?.id).toBe("go.manage.privacy");
    expect(menuNodeByChord("§")).toBeNull();
  });

  it("lists Observe and Manage as the browsable destinations under Go", () => {
    const roots = menuRoots("go").map((node) => node.id);
    expect(roots).toContain("go.observe");
    expect(roots).toContain("go.manage");
    expect(roots).not.toContain("go.manage.tasks");
    expect(menuChildren("go.manage").map((n) => n.label)).toEqual([
      "Tasks",
      "Skills",
      "Memory",
      "MCP",
      "LLM",
      "Telegram",
      "Import",
      "Privacy",
    ]);
  });
});
