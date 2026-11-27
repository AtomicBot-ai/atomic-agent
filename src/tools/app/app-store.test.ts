import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_MAX_BYTES, appDir, appsRoot, cleanAppName, isAppId, newAppId, parseAppManifest } from "./app-names.js";
import { APP_TRASH_DIRNAME, APP_TRASH_KEEP, listApps, readApp, restoreAppVersion, saveApp, trashApp, updateApp } from "./app-store.js";
import { listAppVersions } from "./app-versions.js";

const fixed = (hex: string) => () => Buffer.from(hex, "hex");
const root = () => appsRoot(mkdtempSync(join(tmpdir(), "atomic-apps-")));

describe("app names (the desktop's layout, ATO-2383)", () => {
  it("takes only slug ids, so nothing names a folder outside the apps root", () => {
    for (const ok of ["todo-a1b2c3", "x", "a1-b2-c3"]) expect(isAppId(ok), ok).toBe(true);
    for (const bad of ["", "..", "../x", "a/b", "A-1", "-a", "a--b", ".trash", "x".repeat(65), 7]) {
      expect(isAppId(bad), String(bad)).toBe(false);
    }
    expect(appDir("/s/apps", "../etc")).toBeNull();
    expect(appDir("/s/apps", "todo-a1b2c3")).toBe(join("/s/apps", "todo-a1b2c3"));
  });

  it("cleans names and makes ids from them as the desktop does", () => {
    expect(cleanAppName("  Tip\n calc\t")).toBe("Tip calc");
    expect(cleanAppName("")).toBe("Untitled app");
    expect(newAppId("Tip Calculator!", fixed("abcdef"))).toBe("tip-calculator-abcdef");
    expect(newAppId("Привет", fixed("010203"))).toBe("app-010203");
  });

  it("reads a desktop manifest back, and refuses one for another id", () => {
    const m = { version: 1, id: "a-000000", name: "A", createdAt: "2026-11-01T00:00:00.000Z", bytes: 3, entry: "index.html" };
    expect(parseAppManifest(JSON.stringify(m), "a-000000")?.updatedAt).toBe(m.createdAt);
    expect(parseAppManifest(m, "b-000000")).toBeNull();
    expect(parseAppManifest("{nope", "a-000000")).toBeNull();
  });
});

describe("app store", () => {
  it("saves index.html and app.json where the desktop's My apps reads them", () => {
    const r = root();
    const saved = saveApp(r, { name: "Converter", html: "<h1>fx</h1>", chatId: "s-1" }, Date.UTC(2026, 10, 1), fixed("aaaaaa"));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.app).toMatchObject({ id: "converter-aaaaaa", name: "Converter", sourceChatId: "s-1", bytes: 11, entry: "index.html" });
    expect(readFileSync(join(r, "converter-aaaaaa", "index.html"), "utf8")).toBe("<h1>fx</h1>");
    expect(JSON.parse(readFileSync(join(r, "converter-aaaaaa", "app.json"), "utf8")).version).toBe(1);
    expect(listApps(r).map((a) => a.id)).toEqual(["converter-aaaaaa"]);
  });

  it("refuses an empty or oversized page and writes nothing", () => {
    const r = root();
    expect(saveApp(r, { name: "x", html: "  " })).toEqual({ ok: false, reason: "empty" });
    expect(saveApp(r, { name: "x", html: "a".repeat(APP_MAX_BYTES + 1) })).toEqual({ ok: false, reason: "too-large" });
    expect(existsSync(r)).toBe(false);
  });

  it("an edit keeps the replaced page as a version; the same page again keeps nothing", () => {
    const r = root();
    const saved = saveApp(r, { name: "Fx", html: "<p>v1</p>" }, Date.UTC(2026, 10, 1), fixed("bbbbbb"));
    if (!saved.ok) throw new Error("save");
    const id = saved.app.id;
    const u1 = updateApp(r, id, { html: "<p>v2</p>" }, Date.UTC(2026, 10, 2));
    expect(u1).toMatchObject({ ok: true, pageChanged: true, kept: { version: 1 } });
    expect(readApp(r, id)?.html).toBe("<p>v2</p>");
    const same = updateApp(r, id, { html: "<p>v2</p>" }, Date.UTC(2026, 10, 3));
    expect(same).toMatchObject({ ok: true, pageChanged: false, kept: null });
    const dir = appDir(r, id)!;
    expect(listAppVersions(dir).map((v) => v.version)).toEqual([1]);
    expect(readdirSync(join(dir, "versions"))[0]).toMatch(/^1-\d+\.html$/);
    const renamed = updateApp(r, id, { name: "  New  " }, Date.UTC(2026, 10, 4));
    expect(renamed.ok && renamed.app.name).toBe("New");
    expect(renamed.ok && renamed.app.createdAt).toBe(saved.app.createdAt);
    expect(readApp(r, id)?.html).toBe("<p>v2</p>");
  });

  it("a restore puts the old page back and keeps the one it replaced, so it can be undone", () => {
    const r = root();
    const saved = saveApp(r, { name: "Fx", html: "<p>v1</p>" }, Date.now(), fixed("cccccc"));
    if (!saved.ok) throw new Error("save");
    const id = saved.app.id;
    updateApp(r, id, { html: "<p>v2</p>" });
    const back = restoreAppVersion(r, id, 1);
    expect(back).toMatchObject({ ok: true, pageChanged: true, kept: { version: 2 } });
    expect(readApp(r, id)?.html).toBe("<p>v1</p>");
    expect(restoreAppVersion(r, id, 2).ok).toBe(true);
    expect(readApp(r, id)?.html).toBe("<p>v2</p>");
    expect(restoreAppVersion(r, id, 99)).toEqual({ ok: false, reason: "no-version" });
    expect(restoreAppVersion(r, "gone-000000", 1)).toEqual({ ok: false, reason: "not-found" });
    expect(updateApp(r, "../x", { html: "x" })).toEqual({ ok: false, reason: "bad-id" });
  });

  it("a delete moves the folder to .trash, which is never listed and keeps the newest few", () => {
    const r = root();
    const saved = saveApp(r, { name: "Gone", html: "<p>x</p>" }, Date.now(), fixed("dddddd"));
    if (!saved.ok) throw new Error("save");
    expect(trashApp(r, saved.app.id, 1000)).toEqual({ ok: true });
    expect(existsSync(join(r, saved.app.id))).toBe(false);
    expect(existsSync(join(r, APP_TRASH_DIRNAME, `${saved.app.id}-1000`, "index.html"))).toBe(true);
    expect(listApps(r)).toEqual([]);
    expect(trashApp(r, saved.app.id)).toEqual({ ok: false, reason: "not-found" });
    for (let i = 0; i < APP_TRASH_KEEP + 3; i++) mkdirSync(join(r, APP_TRASH_DIRNAME, `old-000000-${i}`));
    mkdirSync(join(r, "doomed-000000"));
    writeFileSync(join(r, "doomed-000000", "app.json"), "{}");
    expect(trashApp(r, "doomed-000000", 999_999)).toEqual({ ok: true });
    expect(readdirSync(join(r, APP_TRASH_DIRNAME))).toHaveLength(APP_TRASH_KEEP);
  });
});
