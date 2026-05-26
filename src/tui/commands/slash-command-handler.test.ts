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

  it("opens the LLM panel on the active local/cloud route for /models", () => {
    const result = dispatchSlashCommand("/models");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
      { type: "llm_mode_set_to_active_route" },
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

  it("opens the chat model picker for /model", () => {
    const result = dispatchSlashCommand("/model");
    expect(result.actions).toEqual([
      { type: "ui_mode_set", mode: "debug" },
      { type: "tab_changed", tab: "llm" },
    ]);
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
});
