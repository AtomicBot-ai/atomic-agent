import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { applyLaunchConfig, BACKUP_SUFFIX, configRecordPath, revertLaunchConfig, type LaunchConfigFs } from "./launch-config.js";
import { persistSpecFor, type PersistInput } from "./launch-config-targets.js";
import { TOML_DISABLED, withOurEdits, withoutOurEdits } from "./launch-config-toml.js";

/** ATO-2448: `atag launch <agent> --config` and `--revert`, on an in-memory disk. */

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: LaunchConfigFs = {
    read: (p) => files.get(p) ?? null,
    write: (p, t) => void files.set(p, t),
    exists: (p) => files.has(p),
    copy: (a, b) => void files.set(b, files.get(a) ?? ""),
    remove: (p) => void files.delete(p),
  };
  return { fs, files };
}

const input = (over: Partial<PersistInput> = {}): PersistInput => ({
  baseUrl: "http://127.0.0.1:8787/local",
  model: "qwen-local",
  modelGiven: true,
  keyCommand: '"/usr/local/bin/atag" launch --print-key',
  keySource: { kind: "file", path: "/state/serve-api.key" },
  env: {},
  home: "/home/u",
  ...over,
});

const spec = (id: string, over: Partial<PersistInput> = {}) => {
  const s = persistSpecFor(id, input(over));
  if (!s) throw new Error(`no spec for ${id}`);
  return s;
};

const CLAUDE = join("/home/u", ".claude", "settings.json");
const OPENCODE = join("/home/u", ".config", "opencode", "opencode.json");
const CODEX = join("/home/u", ".codex", "config.toml");

describe("launch --config for Claude Code", () => {
  it("sets the base URL, the model and apiKeyHelper, never the key, and keeps the rest", () => {
    const before = JSON.stringify({ theme: "dark", env: { FOO: "1", ANTHROPIC_BASE_URL: "https://old" } });
    const { fs, files } = memoryFs({ [CLAUDE]: before });
    const r = applyLaunchConfig("/state", "claude", spec("claude"), fs);
    expect(r.ok).toBe(true);
    const written = JSON.parse(files.get(CLAUDE) ?? "{}");
    expect(written).toMatchObject({
      theme: "dark",
      apiKeyHelper: '"/usr/local/bin/atag" launch --print-key',
      env: { FOO: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787/local", ANTHROPIC_MODEL: "qwen-local" },
    });
    expect(files.get(CLAUDE)).not.toMatch(/atag_|serve-key/);
    expect(files.get(`${CLAUDE}${BACKUP_SUFFIX}`)).toBe(before);

    const undone = revertLaunchConfig("/state", "claude", fs);
    expect(undone.ok).toBe(true);
    expect(JSON.parse(files.get(CLAUDE) ?? "{}")).toEqual(JSON.parse(before));
    expect(files.has(configRecordPath("/state", "claude"))).toBe(false);
  });

  it("keeps a key the person changed after --config, and says so", () => {
    const { fs, files } = memoryFs({ [CLAUDE]: "{}" });
    applyLaunchConfig("/state", "claude", spec("claude"), fs);
    const edited = JSON.parse(files.get(CLAUDE) ?? "{}");
    edited.env.ANTHROPIC_MODEL = "my-own";
    files.set(CLAUDE, JSON.stringify(edited));
    const undone = revertLaunchConfig("/state", "claude", fs);
    expect(undone.ok && undone.lines.join(" ")).toContain("env.ANTHROPIC_MODEL");
    const after = JSON.parse(files.get(CLAUDE) ?? "{}");
    expect(after).toEqual({ env: { ANTHROPIC_MODEL: "my-own" } });
  });

  it("a second --config replaces the first instead of stacking; revert then restores the original", () => {
    const before = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://old" } });
    const { fs, files } = memoryFs({ [CLAUDE]: before });
    applyLaunchConfig("/state", "claude", spec("claude"), fs);
    applyLaunchConfig("/state", "claude", spec("claude", { model: "other" }), fs);
    expect(JSON.parse(files.get(CLAUDE) ?? "{}").env.ANTHROPIC_MODEL).toBe("other");
    revertLaunchConfig("/state", "claude", fs);
    expect(JSON.parse(files.get(CLAUDE) ?? "{}")).toEqual(JSON.parse(before));
  });

  it("a file launch created is removed again by --revert", () => {
    const { fs, files } = memoryFs();
    applyLaunchConfig("/state", "claude", spec("claude"), fs);
    expect(files.has(CLAUDE)).toBe(true);
    revertLaunchConfig("/state", "claude", fs);
    expect(files.has(CLAUDE)).toBe(false);
  });

  it("leaves a file with comments untouched and says why", () => {
    const { fs, files } = memoryFs({ [CLAUDE]: "{ // mine\n}" });
    const r = applyLaunchConfig("/state", "claude", spec("claude"), fs);
    expect(r.ok).toBe(false);
    expect(files.get(CLAUDE)).toBe("{ // mine\n}");
  });

  it("follows CLAUDE_CONFIG_DIR", () => {
    expect(spec("claude", { env: { CLAUDE_CONFIG_DIR: "/cfg" } }).file.replace(/\\/g, "/")).toBe("/cfg/settings.json");
  });
});

describe("launch --config for OpenCode", () => {
  it("adds an atomic provider that reads the key from the key file, and selects it", () => {
    const { fs, files } = memoryFs({ [OPENCODE]: JSON.stringify({ model: "anthropic/claude", provider: { other: {} } }) });
    applyLaunchConfig("/state", "opencode", spec("opencode"), fs);
    const written = JSON.parse(files.get(OPENCODE) ?? "{}");
    expect(written.model).toBe("atomic/qwen-local");
    expect(written.provider.other).toEqual({});
    expect(written.provider.atomic.options).toEqual({ baseURL: "http://127.0.0.1:8787/local/v1", apiKey: "{file:/state/serve-api.key}" });
    revertLaunchConfig("/state", "opencode", fs);
    expect(JSON.parse(files.get(OPENCODE) ?? "{}")).toEqual({ model: "anthropic/claude", provider: { other: {} } });
  });

  it("uses {env:ATOMIC_AGENT_API_KEY} when the key comes from the environment", () => {
    const s = spec("opencode", { keySource: { kind: "env", name: "ATOMIC_AGENT_API_KEY" } });
    expect(JSON.stringify(s)).toContain("{env:ATOMIC_AGENT_API_KEY}");
  });
});

describe("launch --config for Codex", () => {
  const original = 'model = "gpt-5"\napproval_policy = "never"\n\n[mcp_servers.x]\ncommand = "y"\n';

  it("adds the provider in marked blocks, disables the old top-level model, and --revert restores the file", () => {
    const { fs, files } = memoryFs({ [CODEX]: original });
    const r = applyLaunchConfig("/state", "codex", spec("codex"), fs);
    expect(r.ok && r.lines.join("\n")).toContain("export ATOMIC_AGENT_TOKEN=");
    const text = files.get(CODEX) ?? "";
    expect(text.indexOf('model_provider = "atomic"')).toBeLessThan(text.indexOf("[mcp_servers.x]"));
    expect(text).toContain(`${TOML_DISABLED}model = "gpt-5"`);
    expect(text).toContain('base_url = "http://127.0.0.1:8787/local/v1"');
    expect(text).toContain('env_key = "ATOMIC_AGENT_TOKEN"');
    revertLaunchConfig("/state", "codex", fs);
    expect(files.get(CODEX)).toBe(original);
  });

  it("re-applying replaces our blocks, and a provider of the person's own is never overwritten", () => {
    const once = withOurEdits(original, { topLevel: ["a = 1"], table: ["[t]"] });
    const twice = withOurEdits(once, { topLevel: ["a = 2"], table: ["[t]"] });
    expect(twice.match(/a = /g)).toHaveLength(1);
    expect(withoutOurEdits(twice)).toBe(withoutOurEdits(once));
    const { fs } = memoryFs({ [CODEX]: "[model_providers.atomic]\nname = \"mine\"\n" });
    expect(applyLaunchConfig("/state", "codex", spec("codex"), fs).ok).toBe(false);
  });
});

describe("launch --revert without a setting", () => {
  it("says there is nothing to undo and changes nothing", () => {
    const { fs, files } = memoryFs({ [CLAUDE]: "{}" });
    const r = revertLaunchConfig("/state", "claude", fs);
    expect(r.ok && r.lines[0]).toContain("Nothing to undo");
    expect(files.get(CLAUDE)).toBe("{}");
  });
});
