import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ApprovalGate } from "../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../approval/dangerous-tool.js";
import { ToolRegistry } from "../tool-registry.js";
import { appsRoot } from "./app-names.js";
import { APP_INSTALL_RECORD, appShortcutFolder, type ShortcutPlace } from "./app-shortcut-paths.js";
import { readApp, saveApp } from "./app-store.js";
import type { AppToolOptions } from "./app-tool-shared.js";
import {
  APP_DELETE_TOOL,
  APP_LIST_TOOL,
  APP_SAVE_TOOL,
  APP_UPDATE_TOOL,
  INCOGNITO_APP_REFUSAL,
  buildAppDeleteTool,
  buildAppListTool,
  buildAppSaveTool,
  buildAppUpdateTool,
  registerAppTools,
} from "./index.js";

const ctx = { workingDir: "/work", sessionId: "chat-1", stepIndex: 0, signal: new AbortController().signal };

function gate(approved: boolean) {
  return {
    request: vi.fn(async () => ({ approved, ...(approved ? {} : { reason: "no" }) })),
  } as unknown as ApprovalGate;
}

function options(extra: Partial<AppToolOptions> = {}): AppToolOptions {
  const stateDir = mkdtempSync(join(tmpdir(), "atomic-app-tools-"));
  return { stateDir, approvals: gate(true), approvalRequired: true, now: () => Date.UTC(2026, 10, 27), ...extra };
}

const requests = (o: AppToolOptions) => (o.approvals.request as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);

describe("app.save (ATO-2459)", () => {
  it("asks, then puts the page straight into My apps under the chat's id", async () => {
    const o = options();
    const r = await buildAppSaveTool(o).run({ name: "Currency converter", html: "<h1>fx</h1>" }, ctx);
    expect(r.status).toBe("ok");
    const id = r.details.id as string;
    expect(id).toMatch(/^currency-converter-[0-9a-f]{6}$/);
    expect(r.summary).toContain(id);
    const got = readApp(appsRoot(o.stateDir), id);
    expect(got?.html).toBe("<h1>fx</h1>");
    expect(got?.app.sourceChatId).toBe("chat-1");
    const [ask] = requests(o);
    expect(ask).toMatchObject({ tool: APP_SAVE_TOOL, sessionId: "chat-1", affectedResources: ["app Currency converter"] });
    expect(["fs_write_workspace", "fs_write_home", "other"]).toContain(ask.category);
  });

  it("writes nothing when the person says no", async () => {
    const o = options({ approvals: gate(false) });
    await expect(buildAppSaveTool(o).run({ name: "x", html: "<p>x</p>" }, ctx)).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(existsSync(appsRoot(o.stateDir))).toBe(false);
  });

  it("refuses an empty page before asking", async () => {
    const o = options();
    const r = await buildAppSaveTool(o).run({ name: "x", html: " " }, ctx);
    expect(r).toMatchObject({ status: "error", details: { reason: "empty", field: "html" } });
    expect(requests(o)).toHaveLength(0);
  });
});

describe("app.update", () => {
  it("replaces the page from the chat and keeps the old one as a version", async () => {
    const o = options();
    const saved = saveApp(appsRoot(o.stateDir), { name: "Fx", html: "<p>v1</p>" });
    if (!saved.ok) throw new Error("save");
    const tool = buildAppUpdateTool(o);
    const r = await tool.run({ id: saved.app.id, html: "<p>v2</p>" }, ctx);
    expect(r).toMatchObject({ status: "ok", details: { pageChanged: true, keptVersion: 1 } });
    expect(readApp(appsRoot(o.stateDir), saved.app.id)?.html).toBe("<p>v2</p>");
    expect(requests(o)[0]).toMatchObject({ tool: APP_UPDATE_TOOL });
    const back = await tool.run({ id: saved.app.id, restoreVersion: 1, name: "Fx 2" }, ctx);
    expect(back).toMatchObject({ status: "ok", details: { restoredVersion: 1, keptVersion: 2, name: "Fx 2" } });
    expect(readApp(appsRoot(o.stateDir), saved.app.id)?.html).toBe("<p>v1</p>");
  });

  it("refuses an unknown id, a bad version and html with restoreVersion together", async () => {
    const o = options();
    const saved = saveApp(appsRoot(o.stateDir), { name: "Fx", html: "<p>v1</p>" });
    if (!saved.ok) throw new Error("save");
    const tool = buildAppUpdateTool(o);
    expect((await tool.run({ id: "gone-000000", html: "<p>x</p>" }, ctx)).details.reason).toBe("not-found");
    expect((await tool.run({ id: "../x", html: "<p>x</p>" }, ctx)).details.reason).toBe("bad-id");
    expect((await tool.run({ id: saved.app.id }, ctx)).status).toBe("error");
    expect((await tool.run({ id: saved.app.id, html: "<p>x</p>", restoreVersion: 1 }, ctx)).details.field).toBe("restoreVersion");
    expect((await tool.run({ id: saved.app.id, restoreVersion: 9 }, ctx)).details.reason).toBe("no-version");
  });
});

describe("app.delete", () => {
  it("asks as a move to the Trash, removes the app and its launcher", async () => {
    const home = mkdtempSync(join(tmpdir(), "atomic-app-home-"));
    const place: ShortcutPlace = { platform: "linux", home, env: {} };
    const o = options({ shortcutPlace: place });
    const saved = saveApp(appsRoot(o.stateDir), { name: "Fx", html: "<p>v1</p>" });
    if (!saved.ok) throw new Error("save");
    const folder = appShortcutFolder(place)!;
    mkdirSync(folder, { recursive: true });
    const launcher = join(folder, `atomic-app-${saved.app.id}.desktop`);
    writeFileSync(launcher, "[Desktop Entry]\n");
    writeFileSync(join(appsRoot(o.stateDir), saved.app.id, APP_INSTALL_RECORD), JSON.stringify({ path: launcher }));
    const r = await buildAppDeleteTool(o).run({ id: saved.app.id }, ctx);
    expect(r).toMatchObject({ status: "ok", details: { removed: true, launcherRemoved: true } });
    expect(existsSync(launcher)).toBe(false);
    expect(readApp(appsRoot(o.stateDir), saved.app.id)).toBeNull();
    expect(requests(o)[0]).toMatchObject({ tool: APP_DELETE_TOOL });
    expect(["fs_trash", "other"]).toContain(requests(o)[0].category);
    const again = await buildAppDeleteTool(o).run({ id: saved.app.id }, ctx);
    expect(again).toMatchObject({ status: "ok", details: { removed: false } });
  });
});

describe("app.list", () => {
  it("lists apps, then shows one app's versions and page", async () => {
    const o = options();
    const tool = buildAppListTool(o);
    expect(tool.readonly).toBe(true);
    expect((await tool.run({}, ctx)).summary).toContain("no apps");
    const saved = saveApp(appsRoot(o.stateDir), { name: "Fx", html: "<p>v1</p>" });
    if (!saved.ok) throw new Error("save");
    await buildAppUpdateTool(o).run({ id: saved.app.id, html: "<p>v2 page</p>" }, ctx);
    const all = await tool.run({}, ctx);
    expect(all.summary).toContain(`${saved.app.id} · "Fx"`);
    expect(all.details.count).toBe(1);
    const one = await tool.run({ id: saved.app.id }, ctx);
    expect(one.summary).toContain("version 1");
    expect(one.summary).toContain("<p>v2 page</p>");
    expect((await tool.run({ id: "gone-000000" }, ctx)).details.reason).toBe("not-found");
    expect(requests(o).filter((q) => q.tool === APP_LIST_TOOL)).toHaveLength(0);
  });
});

describe("registerAppTools", () => {
  it("registers the four tools; the writes refuse in an incognito chat", async () => {
    const registry = new ToolRegistry();
    const o = options();
    registerAppTools(registry, { ...o, isIncognitoSession: () => true });
    const names = [APP_SAVE_TOOL, APP_UPDATE_TOOL, APP_DELETE_TOOL, APP_LIST_TOOL];
    for (const n of names) expect(registry.has(n), n).toBe(true);
    const save = registry.get(APP_SAVE_TOOL);
    const r = await save.run({ name: "x", html: "<p>x</p>" }, ctx);
    expect(r).toMatchObject({ status: "error", summary: expect.stringContaining("incognito") });
    expect(r.summary).toContain(INCOGNITO_APP_REFUSAL.slice(0, 30));
    expect(existsSync(appsRoot(o.stateDir))).toBe(false);
    expect((await registry.get(APP_LIST_TOOL).run({}, ctx)).status).toBe("ok");
  });
});
