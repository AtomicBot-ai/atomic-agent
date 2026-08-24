import { describe, expect, it } from "vitest";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("dispatchSlashCommand", () => {
  it("lists slash commands with descriptions for /help", () => {
    const result = dispatchSlashCommand("/help");
    expect(result.systemMessage).toBeDefined();
    expect(result.systemMessage).toContain("slash commands:");
    expect(result.systemMessage).toContain("/dump");
    expect(result.systemMessage).toContain("/clear");
    expect(result.systemMessage).toContain("clear chat transcript");
    expect(result.systemMessage).toContain("/quit");
    expect(result.systemMessage).toContain("aliases: /exit");
  });

  it("forwards non-slash input as a regular message", () => {
    const result = dispatchSlashCommand("hello world");
    expect(result.forwardAsMessage).toBe(true);
    expect(result.actions).toEqual([]);
  });

  it("dispatches chat_cleared for /clear", () => {
    const result = dispatchSlashCommand("/clear");
    expect(result.actions).toEqual([{ type: "chat_cleared" }]);
    expect(result.clearBuffer).toBe(true);
    expect(result.forwardAsMessage).toBe(false);
  });

  it("signals triggerQuit for /quit and its alias /exit", () => {
    const quit = dispatchSlashCommand("/quit");
    expect(quit.triggerQuit).toBe(true);
    const exit = dispatchSlashCommand("/exit");
    expect(exit.triggerQuit).toBe(true);
  });

  /**
   * Off the menu, still a command: the row read badly among entries that
   * name a destination, but typing it is an explicit act and the muscle
   * memory is real.
   */
  it("toggles ui mode for /debug", () => {
    const result = dispatchSlashCommand("/debug");
    expect(result.actions).toEqual([{ type: "ui_mode_toggled" }]);
  });

  it("opens the Observe section default tab for /observe", () => {
    const result = dispatchSlashCommand("/observe");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "feed" },
    ]);
  });

  it("opens the Manage section default tab for /manage", () => {
    const result = dispatchSlashCommand("/manage");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "tasks" },
    ]);
  });

  it("returns to the Run section for /run (alias of /chat)", () => {
    const result = dispatchSlashCommand("/run");
    expect(result.actions).toEqual([{ type: "ui_mode_set", mode: "chat" }]);
  });

  it("switches to debug mode and tab for /logs", () => {
    const result = dispatchSlashCommand("/logs");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "logs" },
    ]);
  });

  it("returns an unknown-command notice when the name is not registered", () => {
    const result = dispatchSlashCommand("/no-such-thing");
    expect(result.actions).toEqual([]);
    expect(result.systemMessage).toContain("unknown command");
    expect(result.clearBuffer).toBe(true);
  });

  it("signals triggerSessionPicker for /sessions", () => {
    const result = dispatchSlashCommand("/sessions");
    expect(result.triggerSessionPicker).toBe(true);
    expect(result.triggerSessionNew).toBe(false);
  });

  it("signals triggerSessionNew for /new", () => {
    const result = dispatchSlashCommand("/new");
    expect(result.triggerSessionNew).toBe(true);
    expect(result.triggerSessionPicker).toBe(false);
  });

  it("signals triggerNewWindow for /window and its alias", () => {
    // `/new` restarts the session in place; `/window` is the OS-level
    // sibling of Ctrl+N — the two must never be confused.
    for (const buffer of ["/window", "/newwindow"]) {
      const result = dispatchSlashCommand(buffer);
      expect(result.triggerNewWindow).toBe(true);
      expect(result.triggerSessionNew).toBe(false);
      expect(result.forwardAsMessage).toBe(false);
    }
    expect(dispatchSlashCommand("/new").triggerNewWindow).toBe(false);
  });

  it("opens the Memory tab for bare /memory", () => {
    const result = dispatchSlashCommand("/memory");
    expect(result.triggerMemoryDump).toBe(false);
    expect(result.actions[0]).toEqual({ type: "ui_mode_set", mode: "debug" });
    expect(result.actions[1]).toEqual({ type: "tab_changed", tab: "memory" });
    expect(result.clearBuffer).toBe(true);
  });

  it("signals triggerMemoryDump for /memory dump", () => {
    const result = dispatchSlashCommand("/memory dump");
    expect(result.triggerMemoryDump).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.clearBuffer).toBe(true);
  });

  it("opens the Skills tab for bare /skills", () => {
    const result = dispatchSlashCommand("/skills");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "skills" },
    ]);
    expect(result.triggerSkillCatalogDump).toBe(false);
    expect(result.clearBuffer).toBe(true);
  });

  it("signals triggerSkillCatalogDump for legacy /skills dump", () => {
    const result = dispatchSlashCommand("/skills dump");
    expect(result.triggerSkillCatalogDump).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.clearBuffer).toBe(true);
  });

  it("emits skillEnableName for /skill enable <name>", () => {
    const result = dispatchSlashCommand("/skill enable apple-notes");
    expect(result.skillEnableName).toBe("apple-notes");
    expect(result.skillDisableName).toBeUndefined();
    expect(result.clearBuffer).toBe(true);
  });

  it("emits skillDisableName for /skill disable <name>", () => {
    const result = dispatchSlashCommand("/skill disable apple-notes");
    expect(result.skillDisableName).toBe("apple-notes");
    expect(result.skillEnableName).toBeUndefined();
  });

  it("rejects /skill enable with no name", () => {
    const result = dispatchSlashCommand("/skill enable");
    expect(result.skillEnableName).toBeUndefined();
    expect(result.systemMessage).toMatch(/usage: \/skill enable/);
  });

  it("signals triggerDebugBundleDump for /dump", () => {
    const result = dispatchSlashCommand("/dump");
    expect(result.triggerDebugBundleDump).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.clearBuffer).toBe(true);
    expect(result.systemMessage).toContain("debug bundle");
  });

  it("opens the LLM panel on the active route and focuses the inline model filter for /model", () => {
    const result = dispatchSlashCommand("/model");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set_to_active_route" },
      { type: "llm_cloud_filter_focus_set", focused: true },
      // Intercepted by submit-handler and routed through the
      // orchestrator callback; it must never reach the reducer.
      { type: "providers_inline_models_ensure_requested", providerId: null },
    ]);
  });

  it("supports /local as an alias for the local LLM panel", () => {
    const result = dispatchSlashCommand("/local");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set", mode: "local" },
    ]);
  });

  it("treats /models as an alias of /model (same actions)", () => {
    expect(dispatchSlashCommand("/models").actions).toEqual(
      dispatchSlashCommand("/model").actions,
    );
  });

  it("routes /models subcommands through the /model dispatcher", () => {
    const result = dispatchSlashCommand("/models use qwen-3.5-4b");
    expect(result.localModelsUseModelId).toBe("qwen-3.5-4b");
  });

  it("requests persistLlamaUrl for /models with a valid URL", () => {
    const result = dispatchSlashCommand("/models http://127.0.0.1:19999");
    expect(result.persistLlamaUrl).toBe("http://127.0.0.1:19999");
    expect(result.clearBuffer).toBe(true);
  });

  it("returns a usage system message for /models with an invalid URL", () => {
    const result = dispatchSlashCommand("/models http://[unclosed");
    expect(result.persistLlamaUrl).toBeUndefined();
    expect(result.systemMessage).toContain("usage");
  });

  it("captures /models pull <id> for orchestrator dispatch", () => {
    const result = dispatchSlashCommand("/models pull qwen-3.5-4b");
    expect(result.localModelsPullModelId).toBe("qwen-3.5-4b");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_focus_set", focus: "local" },
    ]);
  });

  it("captures /models use <id> for orchestrator dispatch", () => {
    const result = dispatchSlashCommand("/models use qwen-3.5-4b");
    expect(result.localModelsUseModelId).toBe("qwen-3.5-4b");
  });

  it("opens the LLM panel for /llm without forcing the current mode", () => {
    const result = dispatchSlashCommand("/llm");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "providers_refresh_requested" },
    ]);
  });

  it("switches text provider through the unified LLM tab", () => {
    const result = dispatchSlashCommand("/llm provider openrouter");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_focus_set", focus: "cloud" },
      { type: "providers_set_active_text", id: "openrouter" },
    ]);
  });

  it("deep-links /llm fallback straight to the Fallback pane", () => {
    const result = dispatchSlashCommand("/llm fallback");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set", mode: "fallback" },
      // Same refresh as bare /llm: the deep link reaches the tab via
      // reducer actions (not onProvidersTabRefresh), so it must request
      // its own re-read or the chain mirror can arrive stale.
      { type: "providers_refresh_requested" },
    ]);
  });

  it("signals triggerLocalModelsStatus for /models status", () => {
    const result = dispatchSlashCommand("/models status");
    expect(result.triggerLocalModelsStatus).toBe(true);
  });

  it("jumps to the Tasks tab for /tasks", () => {
    const result = dispatchSlashCommand("/tasks");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "tasks" },
    ]);
  });

  it("jumps to the Import tab for /import", () => {
    const result = dispatchSlashCommand("/import");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "import" },
    ]);
  });

  it("opens the create form for /task new", () => {
    const result = dispatchSlashCommand("/task new");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "tasks" },
      { type: "tasks_create_form_opened" },
    ]);
  });

  it("returns taskCancelId for /task cancel <id>", () => {
    const result = dispatchSlashCommand("/task cancel abc123");
    expect(result.taskCancelId).toBe("abc123");
    expect(result.actions).toEqual([]);
  });

  it("returns taskRunId for /task run <id>", () => {
    const result = dispatchSlashCommand("/task run abc123");
    expect(result.taskRunId).toBe("abc123");
    expect(result.actions).toEqual([]);
  });

  it("prints usage when /task is called without a verb", () => {
    const result = dispatchSlashCommand("/task");
    expect(result.systemMessage).toContain("usage");
  });

  it("prints usage when /task cancel is called without an id", () => {
    const result = dispatchSlashCommand("/task cancel");
    expect(result.systemMessage).toContain("usage: /task cancel");
  });

  it("opens the interactive picker for bare /theme", () => {
    const result = dispatchSlashCommand("/theme");
    expect(result.actions).toEqual([{ type: "theme_picker_opened" }]);
    expect(result.setThemeName).toBeUndefined();
    expect(result.systemMessage).toBeUndefined();
  });

  it("lists available themes for /theme list", () => {
    const result = dispatchSlashCommand("/theme list");
    expect(result.systemMessage).toContain("available themes:");
    expect(result.systemMessage).toContain("dracula");
    expect(result.setThemeName).toBeUndefined();
    expect(result.actions).toEqual([]);
  });

  it("switches the theme for a known /theme <name>", () => {
    const result = dispatchSlashCommand("/theme dracula");
    expect(result.setThemeName).toBe("dracula");
    expect(result.actions).toEqual([{ type: "theme_set", name: "dracula" }]);
    expect(result.systemMessage).toContain("theme set to dracula");
  });

  it("rejects an unknown /theme <name> without switching", () => {
    const result = dispatchSlashCommand("/theme not-a-theme");
    expect(result.setThemeName).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(result.systemMessage).toContain("unknown theme");
  });

  it("opens the Privacy tab for bare /privacy", () => {
    const result = dispatchSlashCommand("/privacy");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "privacy" },
    ]);
    expect(result.approvalLevelSet).toBeUndefined();
  });

  it("emits approvalLevelSet and opens the tab for /privacy level 1..5", () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const result = dispatchSlashCommand(`/privacy level ${level}`);
      expect(result.approvalLevelSet).toBe(level);
      expect(result.actions).toEqual([
        { type: "ui_mode_set", mode: "debug" },
        { type: "tab_changed", tab: "privacy" },
      ]);
    }
  });

  it("rejects out-of-range or non-numeric /privacy level arguments", () => {
    for (const raw of [
      "/privacy level",
      "/privacy level 0",
      "/privacy level 6",
      "/privacy level 2.5",
      "/privacy level max",
    ]) {
      const result = dispatchSlashCommand(raw);
      expect(result.approvalLevelSet).toBeUndefined();
      expect(result.actions).toEqual([]);
      expect(result.systemMessage).toContain("/privacy level 1 | 2 | 3 | 4 | 5");
    }
  });

  it("keeps /privacy approve on|off as aliases for levels 5 and 1", () => {
    const on = dispatchSlashCommand("/privacy approve on");
    expect(on.approvalLevelSet).toBe(5);
    expect(on.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "privacy" },
    ]);

    const off = dispatchSlashCommand("/privacy approve off");
    expect(off.approvalLevelSet).toBe(1);
    expect(off.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "privacy" },
    ]);
  });

  it("prints usage for /privacy approve without an explicit on|off", () => {
    // No bare form on purpose: `on` means "run everything without
    // asking", so the target state must be named.
    for (const raw of ["/privacy approve", "/privacy approve maybe"]) {
      const result = dispatchSlashCommand(raw);
      expect(result.approvalLevelSet).toBeUndefined();
      expect(result.actions).toEqual([]);
      expect(result.systemMessage).toContain("/privacy approve on | off");
    }
  });

  it("still routes /privacy analytics <verb> to the analytics side-effect", () => {
    const result = dispatchSlashCommand("/privacy analytics off");
    expect(result.analyticsVerb).toBe("disable");
    expect(result.approvalLevelSet).toBeUndefined();
  });

  it("asks for the new default to be persisted on bare /steer and /queue", () => {
    const steer = dispatchSlashCommand("/steer");
    expect(steer.setWhileBusyMode).toBe("steer");
    expect(steer.actions).toEqual([
      { type: "while_busy_mode_changed", mode: "steer" },
    ]);

    // Bare /queue stays a side-effect-free listing — the menu node and
    // the parked chip both invite running it just to look.
    const queue = dispatchSlashCommand("/queue");
    expect(queue.setWhileBusyMode).toBeUndefined();
    expect(queue.queueVerb).toBe("list");
    expect(queue.actions).toEqual([]);

    const queueMode = dispatchSlashCommand("/queue mode");
    expect(queueMode.setWhileBusyMode).toBe("queue");
    expect(queueMode.actions).toEqual([
      { type: "while_busy_mode_changed", mode: "queue" },
    ]);
  });

  it("leaves the persisted default alone for the message-carrying forms", () => {
    const steer = dispatchSlashCommand("/steer use the staging db");
    expect(steer.submitWhileBusy).toEqual({
      mode: "steer",
      text: "use the staging db",
    });
    expect(steer.setWhileBusyMode).toBeUndefined();

    const queue = dispatchSlashCommand("/queue then deploy");
    expect(queue.submitWhileBusy).toEqual({
      mode: "queue",
      text: "then deploy",
    });
    expect(queue.setWhileBusyMode).toBeUndefined();

    expect(dispatchSlashCommand("/queue clear").setWhileBusyMode).toBeUndefined();
  });

  it("/uninstall opens the ladder and asks for a plan — it removes nothing", () => {
    const result = dispatchSlashCommand("/uninstall");
    expect(result.actions).toEqual([{ type: "uninstall_opened" }]);
    expect(result.triggerUninstallPlan).toBe(true);
    // Nothing here quits, aborts or otherwise acts: every decision is
    // the dialog's, and this command only opens it.
    expect(result.triggerQuit).toBe(false);
    expect(result.triggerAbort).toBe(false);
  });

});
