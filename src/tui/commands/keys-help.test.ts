import { describe, expect, it } from "vitest";
import { COMPOSER_SWITCH_KEY_LABEL } from "../composer-switch/composer-switch-key-bindings.js";
import { MENU_LEADER_LABEL } from "../menu/menu-keys.js";
import { KEYS_HELP, formatKeysHelp } from "./keys-help.js";
import { dispatchSlashCommand } from "./slash-command-handler.js";

describe("keys block in /help (ATO-2772)", () => {
  it("names ctrl+p, which no other help text listed", () => {
    expect(formatKeysHelp()).toMatch(/ctrl\+p\s+switch to the next favorite model/);
  });

  it("uses the labels the key handlers use", () => {
    const keys = KEYS_HELP.map(([key]) => key);
    expect(keys).toContain(MENU_LEADER_LABEL);
    expect(keys).toContain(COMPOSER_SWITCH_KEY_LABEL);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is printed after the slash commands", () => {
    const text = dispatchSlashCommand("/help").systemMessage ?? "";
    expect(text.indexOf("keys:")).toBeGreaterThan(text.indexOf("slash commands:"));
    expect(text).toContain("ctrl+p");
  });
});
