import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundleRunsCode, readPluginBundle } from "./plugin-bundle.js";
import { installPluginFromDir, setPluginCodeAllowed, setPluginPartEnabled } from "./plugin-install.js";
import { parseMonitorEntries } from "./plugin-monitor-entries.js";
import { listPluginMonitors } from "./plugin-monitors.js";
import { buildPluginOverview, formatPluginCounts, pluginCodeParts } from "./plugin-overview.js";
import { codeConsentIdOf, describePermissionDiff, describePluginCode, diffPluginPermissions, pluginPermissionSnapshot } from "./plugin-permissions.js";
import { resetPluginCache } from "./plugin-runtime.js";
import { installedPluginDir, readPluginState } from "./plugin-store.js";
import { writeClaudePlugin } from "./plugin-test-helpers.js";

/**
 * ATO-2438: a plugin declares background commands (`monitors`, Claude
 * Code's shape). They are read without running anything, count as code
 * that needs the user's consent, show in the permission diff and the
 * plugin views, and only an allowed plugin's monitors are offered to start.
 */

const DEPLOY = { name: "deploy-status", command: "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/poll.sh", description: "Deployment status changes", until: "failed|ready" };

describe("plugin monitors", () => {
  let base: string;
  let stateDir: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "atomic-plugin-monitors-"));
    stateDir = join(base, "state");
    resetPluginCache();
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(base, "src", rel)), { recursive: true });
    writeFileSync(join(base, "src", rel), content);
  };

  it("reads experimental.monitors inline, and no longer skips the key", () => {
    const root = writeClaudePlugin(join(base, "src"), { manifest: { experimental: { monitors: [DEPLOY] } } });
    const bundle = readPluginBundle(root);
    expect(bundle.monitors).toEqual([DEPLOY]);
    expect(bundle.notes.join("\n")).not.toContain('Skipped "monitors"');
    expect(bundleRunsCode(bundle)).toBe(true);
  });

  it("reads monitors/monitors.json by default and a top-level path key", () => {
    put("monitors/monitors.json", JSON.stringify([{ name: "tail", command: "tail -F log", description: "Log lines" }]));
    const byDefault = readPluginBundle(writeClaudePlugin(join(base, "src")));
    expect(byDefault.monitors).toEqual([{ name: "tail", command: "tail -F log", description: "Log lines" }]);
    expect(byDefault.monitorsFile).toBe(join(base, "src", "monitors", "monitors.json"));
    put("config/m.json", JSON.stringify({ monitors: [DEPLOY] }));
    const byPath = readPluginBundle(writeClaudePlugin(join(base, "src"), { manifest: { monitors: "./config/m.json" } }));
    expect(byPath.monitors.map(m => m.name)).toEqual(["deploy-status"]);
  });

  it("skips a bad entry with a note and keeps the others", () => {
    const notes: string[] = [];
    const ok = { name: "ok", command: "watch.sh", description: "Fine" };
    const out = parseMonitorEntries([
      ok,
      { ...ok, name: "extra", matcher: "x" },
      { ...ok, name: "skill", when: "on-skill-invoke:deploy" },
      { name: "nodesc", command: "x" },
      { ...ok, name: "badpattern", until: "(" },
      { ...ok, name: "secret", command: "run ${user_config.token}" },
      { ...ok },
      "not an object",
    ], notes);
    expect(out).toEqual([ok]);
    expect(notes).toEqual([
      'Skipped monitor "extra": unknown key "matcher".',
      'Skipped monitor "skill": it starts when a skill runs (on-skill-invoke:deploy), which is not supported yet.',
      'Skipped monitor "nodesc": needs a `description`.',
      'Skipped monitor "badpattern": `until` is not a valid pattern.',
      'Skipped monitor "secret": a monitor command cannot use ${user_config.*}.',
      'Skipped monitor "ok": the name is used twice.',
      "Skipped monitor #8: not an object.",
    ]);
  });

  it("refuses a monitors path outside the plugin", () => {
    const root = writeClaudePlugin(join(base, "src"), { manifest: { monitors: "../elsewhere.json" } });
    expect(() => readPluginBundle(root)).toThrow(/points outside the plugin/);
  });

  it("lists monitors as code: consent lines, the diff and the consent id", () => {
    const before = readPluginBundle(writeClaudePlugin(join(base, "old")));
    const after = readPluginBundle(writeClaudePlugin(join(base, "new"), { manifest: { experimental: { monitors: [DEPLOY] } } }));
    const snap = pluginPermissionSnapshot(after);
    expect(snap.monitors).toEqual([{ name: "deploy-status", command: DEPLOY.command, until: "failed|ready" }]);
    expect(describePluginCode(snap)).toContain(`monitor deploy-status, runs in the background from each chat's first message: ${DEPLOY.command}`);
    const diff = diffPluginPermissions(before, after);
    expect(diff.codeChanged).toBe(true);
    expect(describePermissionDiff(diff)).toContain(`New or changed monitor deploy-status runs: ${DEPLOY.command}`);
    expect(codeConsentIdOf(snap)).not.toBe(codeConsentIdOf({ ...snap, monitors: [] }));
    // A changed pattern is a changed monitor: earlier consent no longer covers it.
    const changed = readPluginBundle(writeClaudePlugin(join(base, "new"), { manifest: { experimental: { monitors: [{ ...DEPLOY, until: "." }] } } }));
    expect(diffPluginPermissions(after, changed).codeChanged).toBe(true);
  });

  it("shows monitors in the plugin overview and its counts", () => {
    const root = writeClaudePlugin(join(base, "src"), { manifest: { experimental: { monitors: [DEPLOY] } } });
    installPluginFromDir(stateDir, root, { acceptCode: true });
    const record = readPluginState(stateDir).plugins.demo!;
    const bundle = readPluginBundle(installedPluginDir(stateDir, "demo"));
    const overview = buildPluginOverview(record, bundle);
    expect(overview.counts.monitors).toBe(1);
    expect(formatPluginCounts(overview.counts)).toContain("1 monitor");
    expect(overview.parts.find(p => p.kind === "monitor")).toMatchObject({ id: "monitor:deploy-status", runsCode: true, active: true });
    expect(pluginCodeParts(bundle)).toContain("monitors: deploy-status");
  });

  it("offers a monitor to start only when code is allowed and the part is on", () => {
    installPluginFromDir(stateDir, writeClaudePlugin(join(base, "src"), { manifest: { experimental: { monitors: [DEPLOY] } } }));
    expect(listPluginMonitors(stateDir)).toEqual({
      monitors: [],
      skipped: [expect.objectContaining({ plugin: "demo", name: "deploy-status", reason: expect.stringContaining("allow-code") })],
    });
    setPluginCodeAllowed(stateDir, "demo", true);
    resetPluginCache();
    const { monitors } = listPluginMonitors(stateDir);
    expect(monitors).toEqual([{
      plugin: "demo",
      name: "deploy-status",
      key: "demo/deploy-status",
      description: "Deployment status changes",
      command: `"${installedPluginDir(stateDir, "demo")}"/scripts/poll.sh`,
      until: "failed|ready",
    }]);
    setPluginPartEnabled(stateDir, "demo", "monitor:deploy-status", false);
    resetPluginCache();
    expect(listPluginMonitors(stateDir)).toEqual({ monitors: [], skipped: [] });
  });
});
