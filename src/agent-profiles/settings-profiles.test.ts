import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfigNoticeSink } from "../config/config-primitives.js";
import { loadAgentProfiles } from "./profile-loader.js";
import { readSettingsAgentProfiles } from "./settings-profiles.js";

describe("readSettingsAgentProfiles (ATO-1668)", () => {
  let base: string;
  let configFile: string;
  let notices: string[];
  const cached = { cached: { prompt: "CACHED" } };
  const fallback = () => cached;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "settings-profiles-")));
    configFile = join(base, "config.json");
    notices = [];
    setConfigNoticeSink((line) => notices.push(line));
  });
  afterEach(() => {
    setConfigNoticeSink(null);
    rmSync(base, { recursive: true, force: true });
  });

  function writeProfiles(agentProfiles: unknown): void {
    writeFileSync(configFile, JSON.stringify({ version: 1, llm: { runMode: { agentProfiles } } }));
  }

  it("sees an edit of config.json on the next load, with no config cache reset", () => {
    const repo = join(base, "repo");
    const state = join(base, "state");
    mkdirSync(repo);
    mkdirSync(state);
    const load = () =>
      loadAgentProfiles({
        workingDir: repo,
        stateDir: state,
        configFile,
        startupTrust: [],
        settingsProfiles: () => readSettingsAgentProfiles(configFile, fallback),
      });

    writeProfiles({ writer: { prompt: "FIRST" } });
    expect(load().get("writer")).toMatchObject({ source: "settings", prompt: "FIRST" });

    writeProfiles({ writer: { prompt: "SECOND", tools: "Read, Grep" }, review: { prompt: "MINE" } });
    const second = load();
    expect(second.get("writer")).toMatchObject({ prompt: "SECOND", tools: ["Read", "Grep"] });
    expect(second.get("review")).toMatchObject({ source: "settings", prompt: "MINE" });
    expect(second.get("cached")).toBeUndefined();
  });

  it("goes through the config parser: a broken entry is skipped, the others load", () => {
    writeProfiles({ "broken-1668": { prompt: "" }, fine: { prompt: "FINE" } });
    const out = readSettingsAgentProfiles(configFile, fallback);
    expect(out).toEqual({ fine: { prompt: "FINE" } });
    expect(notices.join("\n")).toContain("llm.runMode.agentProfiles.broken-1668");
  });

  it("no file is no settings profiles; a file without the node is none too", () => {
    expect(readSettingsAgentProfiles(join(base, "missing.json"), fallback)).toBeUndefined();
    writeFileSync(configFile, JSON.stringify({ version: 1 }));
    expect(readSettingsAgentProfiles(configFile, fallback)).toBeUndefined();
  });

  it("falls back to the cached config when the file is not JSON or the node is not an object", () => {
    writeFileSync(configFile, "not json");
    expect(readSettingsAgentProfiles(configFile, fallback)).toBe(cached);
    writeProfiles(["not", "a", "map"]);
    expect(readSettingsAgentProfiles(configFile, fallback)).toBe(cached);
  });
});
