import { describe, expect, it } from "vitest";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("dispatchSlashCommand", () => {
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

  it("requests persistLlamaUrl for /llama with a valid URL", () => {
    const result = dispatchSlashCommand("/llama http://127.0.0.1:19999");
    expect(result.persistLlamaUrl).toBe("http://127.0.0.1:19999");
    expect(result.clearBuffer).toBe(true);
  });

  it("rejects invalid /llama URL with a system message", () => {
    const result = dispatchSlashCommand("/llama http://[unclosed");
    expect(result.persistLlamaUrl).toBeUndefined();
    expect(result.systemMessage).toContain("invalid");
  });
});
