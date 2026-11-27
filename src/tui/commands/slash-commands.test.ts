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

  // ATO-1640 / ATO-2772: someone looking for the Fusion switch types
  // `/fusion`. That name is the unfinished-runs command, so the switch
  // comes second, found through its search keywords.
  it("lists /runmode under /fusion when the query is fusion", () => {
    for (const query of ["fusion", "fus"]) {
      const names = filterSlashCommands(query).map((c) => c.name);
      expect(names[0]).toBe("fusion");
      expect(names).toContain("runmode");
    }
  });

  it("ranks a keyword-only match below every name and alias match", () => {
    const names = filterSlashCommands("local").map((c) => c.name);
    expect(names[0]).toBe("model");
    expect(names.indexOf("runmode")).toBeGreaterThan(0);
  });

  it("never dispatches a search keyword", () => {
    expect(resolveSlashCommand("fusion")?.name).toBe("fusion");
    expect(resolveSlashCommand("cloud")).toBeNull();
  });
});

describe("resolveSlashCommand", () => {
  it("resolves canonical names", () => {
    expect(resolveSlashCommand("clear")?.name).toBe("clear");
  });

  it("resolves aliases", () => {
    expect(resolveSlashCommand("exit")?.name).toBe("quit");
  });

  it("resolves /models and /local as aliases of /model", () => {
    expect(resolveSlashCommand("models")?.name).toBe("model");
    expect(resolveSlashCommand("local")?.name).toBe("model");
  });

  it("keeps a single registry entry for the model command", () => {
    const modelish = SLASH_COMMANDS.filter(
      (c) => c.name === "model" || c.name === "models",
    );
    expect(modelish.map((c) => c.name)).toEqual(["model"]);
  });

  it("returns null for unknown commands", () => {
    expect(resolveSlashCommand("does-not-exist")).toBeNull();
  });
});
