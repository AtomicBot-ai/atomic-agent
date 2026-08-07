import { describe, expect, it } from "vitest";
import {
  filterSlashCommands,
  resolveSlashCommand,
  SLASH_COMMANDS,
} from "./slash-commands.js";

describe("SLASH_COMMANDS registry", () => {
  it("contains the expected baseline commands", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    for (const expected of [
      "help",
      "clear",
      "abort",
      "quit",
      "debug",
      "chat",
      "feed",
      "logs",
      "reasoning",
      "world",
    ]) {
      expect(names).toContain(expected);
    }
  });
});

describe("filterSlashCommands", () => {
  it("returns the full registry for an empty query", () => {
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands("  ").length).toBe(SLASH_COMMANDS.length);
  });

  it("prioritises direct prefix matches", () => {
    const results = filterSlashCommands("cl");
    expect(results[0]?.name).toBe("clear");
  });

  it("matches aliases for quit/exit", () => {
    const results = filterSlashCommands("ex");
    expect(results.map((c) => c.name)).toContain("quit");
  });
});

describe("resolveSlashCommand", () => {
  it("resolves canonical names", () => {
    expect(resolveSlashCommand("clear")?.name).toBe("clear");
  });

  it("resolves aliases", () => {
    expect(resolveSlashCommand("exit")?.name).toBe("quit");
  });

  it("resolves /model and /local as aliases of /models", () => {
    expect(resolveSlashCommand("model")?.name).toBe("models");
    expect(resolveSlashCommand("local")?.name).toBe("models");
  });

  it("keeps a single registry entry for the model command", () => {
    const modelish = SLASH_COMMANDS.filter(
      (c) => c.name === "model" || c.name === "models",
    );
    expect(modelish.map((c) => c.name)).toEqual(["models"]);
  });

  it("returns null for unknown commands", () => {
    expect(resolveSlashCommand("does-not-exist")).toBeNull();
  });
});
