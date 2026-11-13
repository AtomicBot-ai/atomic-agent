// ATO-42: projects (a group of chats with one work folder and shared
// instructions). Unit tests for main/projects-store.ts, against the built
// output. Run: npm run build && npm run test:unit
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../out/main/projects-store.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function stateDir() {
  const d = mkdtempSync(join(tmpdir(), "aa-projects-"));
  dirs.push(d);
  return d;
}
let n = 0;
const ids = () => `ptest${String(++n).padStart(4, "0")}`;

test("a new project gets an id, is named after its folder, and goes on top", () => {
  let d = P.emptyProjects();
  const a = P.saveProject(d, { folder: "/Users/me/site/" }, 1, ids);
  assert.ok(a.ok);
  assert.match(a.project.id, /^p[a-z0-9]+$/);
  assert.match(a.project.id, /^[\w.:-]{1,80}$/, "fits the sidebar's id rule");
  assert.equal(a.project.name, "site");
  assert.equal(a.project.instructions, "");
  assert.equal(a.project.createdAt, 1);
  d = a.data;
  const b = P.saveProject(d, { name: "  Docs\nwork ", folder: "C:\\work\\docs", instructions: "  Write in English.  " }, 2, ids);
  assert.ok(b.ok);
  assert.equal(b.project.name, "Docs work");
  assert.equal(b.project.instructions, "Write in English.");
  assert.deepEqual(b.data.projects.map((p) => p.id), [b.project.id, a.project.id]);
  // The default id maker works too.
  const c = P.saveProject(b.data, { name: "x", folder: "/x" });
  assert.ok(c.ok);
  assert.match(c.project.id, /^p[a-z0-9]{12}$/);
});

test("an update changes only what it sends and keeps the id and the date", () => {
  const a = P.saveProject(P.emptyProjects(), { name: "Site", folder: "/site", instructions: "Use tabs." }, 5, ids);
  const u = P.saveProject(a.data, { id: a.project.id, instructions: "Use spaces." }, 99, ids);
  assert.ok(u.ok);
  assert.deepEqual(u.project, { ...a.project, instructions: "Use spaces." });
  assert.equal(u.data.projects.length, 1);
  const r = P.saveProject(u.data, { id: a.project.id, name: "Site v2" }, 99, ids);
  assert.equal(r.project.name, "Site v2");
  assert.equal(r.project.instructions, "Use spaces.");
});

test("save refuses what it cannot keep", () => {
  const d = P.emptyProjects();
  assert.equal(P.saveProject(d, null).ok, false);
  assert.equal(P.saveProject(d, { name: "No folder" }).ok, false);
  assert.equal(P.saveProject(d, { name: "Rel", folder: "relative/path" }).ok, false);
  assert.equal(P.saveProject(d, { id: "pnope00", name: "x", folder: "/x" }).ok, false, "an unknown id is not created");
  assert.equal(P.saveProject(d, { name: "x", folder: "/x", instructions: 5 }).ok, false);
  const long = P.saveProject(d, { name: "x", folder: "/x", instructions: "y".repeat(P.MAX_PROJECT_INSTRUCTIONS + 1) });
  assert.equal(long.ok, false, "too long is refused, not cut");
  assert.ok(P.saveProject(d, { name: "x", folder: "/x", instructions: "y".repeat(P.MAX_PROJECT_INSTRUCTIONS) }).ok);
  assert.equal(Array.from(P.saveProject(d, { name: "😀".repeat(200), folder: "/x" }, 1, ids).project.name).length, P.MAX_PROJECT_NAME);
});

test("assign puts a chat in one project; null takes it out; unknown projects are refused", () => {
  const a = P.saveProject(P.emptyProjects(), { name: "A", folder: "/a" }, 1, ids);
  const b = P.saveProject(a.data, { name: "B", folder: "/b" }, 2, ids);
  let d = b.data;
  d = P.assignChat(d, "s1", a.project.id).data;
  d = P.assignChat(d, "s1", b.project.id).data;
  assert.deepEqual(d.chats, { s1: b.project.id }, "one project per chat");
  assert.equal(P.projectForChat(d, "s1").name, "B");
  assert.equal(P.assignChat(d, "s2", "pnope00").ok, false);
  assert.equal(P.assignChat(d, "", a.project.id).ok, false);
  assert.equal(P.assignChat(d, "bad\nid", a.project.id).ok, false);
  d = P.assignChat(d, "s1", null).data;
  assert.deepEqual(d.chats, {});
  assert.equal(P.projectForChat(d, "s1"), null);
});

test("deleting a project takes its chats out of it and leaves the others", () => {
  const a = P.saveProject(P.emptyProjects(), { name: "A", folder: "/a" }, 1, ids);
  const b = P.saveProject(a.data, { name: "B", folder: "/b" }, 2, ids);
  let d = P.assignChat(b.data, "s1", a.project.id).data;
  d = P.assignChat(d, "s2", b.project.id).data;
  const del = P.deleteProject(d, a.project.id);
  assert.ok(del.ok);
  assert.deepEqual(del.data.projects.map((p) => p.name), ["B"]);
  assert.deepEqual(del.data.chats, { s2: b.project.id });
  assert.equal(P.deleteProject(del.data, a.project.id).ok, false);
});

test("coerce drops bad entries, duplicate ids and dangling chat links", () => {
  const good = { id: "pgood001", name: "Good", folder: "/g", instructions: "ok", createdAt: 3 };
  const d = P.coerceProjects({
    projects: [good, { ...good, name: "dupe" }, { id: "BAD", name: "x", folder: "/x" }, { id: "pnofolder", name: "x" },
      { id: "prel0001", name: "x", folder: "rel" }, { id: "pnoname1", name: "  ", folder: "/n" }, "junk"],
    chats: { s1: "pgood001", s2: "pgone001", s3: 7 },
    extra: true,
  });
  assert.deepEqual(d, { version: 1, projects: [good], chats: { s1: "pgood001" } });
  assert.deepEqual(P.coerceProjects(null), P.emptyProjects());
  assert.deepEqual(P.coerceProjects({ projects: "x", chats: [] }), P.emptyProjects());
});

test("a turn takes the project's folder for a new chat and its instructions", () => {
  const a = P.saveProject(P.emptyProjects(), { name: "Site", folder: "/site", instructions: "Use tabs." }, 1, ids);
  const empty = P.saveProject(a.data, { name: "Bare", folder: "/bare" }, 2, ids);
  let d = P.assignChat(empty.data, "s1", a.project.id).data;
  d = P.assignChat(d, "s2", empty.project.id).data;
  const isDir = (dir) => dir === "/site" || dir === "/bare";

  const stored = P.turnProject(d, { sessionId: "s1", windowDir: "/home", remote: false, isDir });
  assert.equal(stored.project.id, a.project.id);
  assert.equal(stored.workingDir, "/site");
  assert.deepEqual(stored.instructions, { name: "Site", text: "Use tabs." });

  const fresh = P.turnProject(d, { sessionId: null, projectId: a.project.id, windowDir: "/home", remote: false, isDir });
  assert.equal(fresh.project.id, a.project.id, "a new chat started in a project");
  assert.equal(fresh.workingDir, "/site");

  // A stored chat's own project wins over the one the window names.
  assert.equal(P.turnProject(d, { sessionId: "s2", projectId: a.project.id, windowDir: "/home", remote: false, isDir }).project.id, empty.project.id);

  const bare = P.turnProject(d, { sessionId: "s2", windowDir: "/home", remote: false, isDir });
  assert.equal(bare.instructions, null, "a project with no text clears the agent's copy");

  const none = P.turnProject(d, { sessionId: "s9", windowDir: "/home", remote: false, isDir });
  assert.deepEqual(none, { project: null, workingDir: "/home", instructions: null });

  const gone = P.turnProject(d, { sessionId: "s1", windowDir: "/home", remote: false, isDir: () => false });
  assert.equal(gone.workingDir, "/home", "a project folder that is gone falls back to the window's");
  assert.deepEqual(gone.instructions, { name: "Site", text: "Use tabs." });

  const remote = P.turnProject(d, { sessionId: "s1", windowDir: "/home", remote: true, isDir });
  assert.equal(remote.workingDir, undefined, "a remote agent gets no local path");
  assert.deepEqual(remote.instructions, { name: "Site", text: "Use tabs." });
});

test("the chat request's project fields", () => {
  assert.deepEqual(P.projectBodyFields(undefined), {});
  assert.deepEqual(P.projectBodyFields(null), { project_instructions: null });
  assert.deepEqual(P.projectBodyFields({ name: "Site", text: "Use tabs." }), { project_instructions: "Use tabs.", project_name: "Site" });
});

test("on disk: written whole, read back, a broken file set aside, the change hook only after a write", () => {
  const dir = stateDir();
  assert.deepEqual(P.readProjects(dir), P.emptyProjects());
  let changed = 0;
  const saved = P.updateProjects(dir, (d) => P.saveProject(d, { name: "Site", folder: "/site" }, 1, ids), () => changed++);
  assert.ok(saved.ok);
  assert.equal(changed, 1);
  assert.equal(saved.project.name, "Site");
  assert.deepEqual(P.readProjects(dir).projects.map((p) => p.name), ["Site"]);
  const refused = P.updateProjects(dir, (d) => P.assignChat(d, "s1", "pnope00"), () => changed++);
  assert.equal(refused.ok, false);
  assert.equal(changed, 1, "no event for a refused change");
  assert.ok(P.updateProjects(dir, (d) => P.assignChat(d, "s1", saved.project.id)).ok);
  assert.deepEqual(JSON.parse(readFileSync(P.projectsPath(dir), "utf8")).chats, { s1: saved.project.id });
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")));

  writeFileSync(P.projectsPath(dir), "{ not json");
  assert.deepEqual(P.readProjects(dir), P.emptyProjects());
  assert.ok(readdirSync(dir).some((f) => f.startsWith("projects.json.bad-")), "the broken file is kept for recovery");
});

test("main and preload wire the projects IPC and the change event", () => {
  const main = readFileSync(new URL("../main/main.ts", import.meta.url), "utf8");
  for (const ch of ["projects:list", "projects:save", "projects:delete", "projects:assign"]) {
    assert.ok(main.includes(`ipcMain.handle("${ch}"`), ch);
  }
  assert.ok(main.includes('send("projects:changed")'));
  assert.match(main, /client\.chat\(turnId, clean, chatId, proj\.workingDir, proj\.instructions\)/);
  const preload = readFileSync(new URL("../preload/preload.ts", import.meta.url), "utf8");
  for (const name of ["projectsList", "projectsSave", "projectsDelete", "projectsAssign", "onProjectsChanged"]) {
    assert.ok(preload.includes(`${name}:`), name);
  }
  assert.ok(preload.includes('on("projects:changed"'));
});
