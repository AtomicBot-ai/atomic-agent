import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  coerceFoldersFile,
  emptyFoldersFile,
  emptyProjectsFile,
  groupHintFromCwd,
  groupImportReport,
  mergeGroupingFrom,
  namedGroupHint,
  planImportGrouping,
  type ImportGroupHint,
} from "./grouping.js";
import {
  buildReport,
  type ImportItemResult,
  type ImportReport,
} from "./import-report.js";

const hint = (dir: string): ImportGroupHint => groupHintFromCwd(dir)!;

function ids(prefix: string) {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(6, "0")}`;
}

describe("groupHintFromCwd", () => {
  it("names a group after the folder's last segment", () => {
    expect(groupHintFromCwd("/Users/me/src/app/")).toEqual({
      key: "/Users/me/src/app/",
      name: "app",
      cwd: "/Users/me/src/app/",
    });
    expect(groupHintFromCwd("C:\\work\\site")).toMatchObject({ name: "site" });
  });

  it("has no group for a missing or relative cwd", () => {
    expect(groupHintFromCwd(null)).toBeUndefined();
    expect(groupHintFromCwd("relative/dir")).toBeUndefined();
    expect(groupHintFromCwd("/")).toBeUndefined();
  });

  it("files an agent's worktree under its repository", () => {
    expect(groupHintFromCwd("/Users/me/app/.claude/worktrees/kind-ellis-b45ecb", "/Users/me"))
      .toEqual({ key: "/Users/me/app", name: "app", cwd: "/Users/me/app" });
    expect(groupHintFromCwd("/Users/me/app/.codex/worktrees/x/src", "/Users/me")).toMatchObject({ name: "app" });
  });

  it("makes no project of the home folder, /tmp or the Claude app's scratch space", () => {
    const home = "/Users/me";
    expect(groupHintFromCwd("/Users/me", home)).toBeUndefined();
    expect(groupHintFromCwd("/Users/me/", home)).toBeUndefined();
    expect(groupHintFromCwd("/Users/me/.claude/worktrees/busy-wing-9701f2", home)).toBeUndefined();
    expect(groupHintFromCwd("/Users/me/.claude-worktrees/amazing-colden-5dc37b", home)).toBeUndefined();
    // Where the system temp folder is /tmp itself (Linux) it holds the test
    // fixtures, so /tmp is only ruled out on a Mac-style per-user temp folder.
    if (!/^\/(?:private\/)?tmp(?:\/|$)/.test(tmpdir())) {
      expect(groupHintFromCwd("/private/tmp", home)).toBeUndefined();
      expect(groupHintFromCwd("/tmp/build", home)).toBeUndefined();
    }
    expect(groupHintFromCwd(
      "/Users/me/Library/Application Support/Claude/scratch-workspaces/13c6/0645/scratch-2026-09-30-29eb57", home,
    )).toBeUndefined();
    expect(groupHintFromCwd("/Users/me/Desktop/site", home)).toMatchObject({ name: "site" });
  });

  it("W2 QA: worktrees the apps keep in the home folder group by their repository's name", () => {
    const home = "/Users/me";
    expect(groupHintFromCwd("/Users/me/.codex/worktrees/a1b2/app/src", home))
      .toEqual({ key: "worktree-repo:app", name: "app", cwd: null });
    expect(groupHintFromCwd("/Users/me/.cursor/worktrees/app/feat-x", home))
      .toEqual({ key: "worktree-repo:app", name: "app", cwd: null });
    expect(groupHintFromCwd("/Users/me/conductor/workspaces/site/lisbon", home))
      .toEqual({ key: "worktree-repo:site", name: "site", cwd: null });
    expect(groupHintFromCwd("/Users/me/.claude/worktrees/amazing-colden", home)).toBeUndefined();
    expect(groupHintFromCwd("/Users/me/src/app/.claude/worktrees/busy-wing", home))
      .toMatchObject({ key: "/Users/me/src/app", name: "app" });
  });
});

describe("planImportGrouping", () => {
  const exists = new Set(["/src/app", "/src/site", "/client/app"]);
  const isDir = (d: string) => exists.has(d.replace(/\/+$/, ""));
  const base = {
    isDir,
    now: 1000,
    newProjectId: ids("p"),
    newFolderId: ids("f"),
  };

  it("makes a project per existing folder and a chat folder per missing one", () => {
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders: emptyFoldersFile(),
      entries: [
        { sessionId: "claude-code:a", group: hint("/src/app") },
        { sessionId: "claude-code:b", group: hint("/src/app") },
        { sessionId: "claude-code:c", group: hint("/src/site") },
        { sessionId: "claude-code:d", group: hint("/gone/old-thing") },
      ],
    });
    expect(plan.outcomes).toEqual([
      { kind: "project", name: "app", path: "/src/app", created: true, chats: 2, added: 2, kept: 0 },
      { kind: "project", name: "site", path: "/src/site", created: true, chats: 1, added: 1, kept: 0 },
      { kind: "folder", name: "old-thing", path: "/gone/old-thing", created: true, chats: 1, added: 1, kept: 0 },
    ]);
    const app = plan.projects.projects.find((p) => p.folder === "/src/app")!;
    expect(app).toMatchObject({ name: "app", instructions: "", createdAt: 1000 });
    expect(plan.projects.chats["claude-code:a"]).toBe(app.id);
    expect(plan.projects.chats["claude-code:b"]).toBe(app.id);
    // Out of every folder, so the desktop's per-app sorting leaves it alone.
    expect(plan.folders.chats["claude-code:a"]).toBeNull();
    const old = plan.folders.folders.find((f) => f.name === "old-thing")!;
    expect(plan.folders.chats["claude-code:d"]).toBe(old.id);
    expect(plan.folders.projects[old.id]).toBe("/gone/old-thing");
    expect(plan.folders.auto["claude-code:d"]).toBeUndefined();
  });

  it("gives a second project with the same name its parent's name too", () => {
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders: emptyFoldersFile(),
      entries: [
        { sessionId: "x:1", group: hint("/src/app") },
        { sessionId: "x:2", group: hint("/client/app") },
      ],
    });
    expect(plan.outcomes.map((o) => o.name)).toEqual(["app", "app (client)"]);
  });

  it("is idempotent: a second run finds the same project and folder and moves nothing", () => {
    const entries = [
      { sessionId: "codex:1", group: hint("/src/app") },
      { sessionId: "codex:2", group: hint("/gone/x") },
    ];
    const first = planImportGrouping({ ...base, projects: emptyProjectsFile(), folders: emptyFoldersFile(), entries });
    const second = planImportGrouping({ ...base, projects: first.projects, folders: first.folders, entries });
    expect(second.projectsChanged).toBe(false);
    expect(second.foldersChanged).toBe(false);
    expect(second.projects).toEqual(first.projects);
    expect(second.folders).toEqual(first.folders);
    expect(second.outcomes.map((o) => [o.created, o.added])).toEqual([[false, 0], [false, 0]]);
  });

  it("finds an existing project by its folder, whatever it is called now", () => {
    const projects = {
      ...emptyProjectsFile(),
      projects: [{ id: "pexisting1", name: "My renamed app", folder: "/src/app/", instructions: "be brief", createdAt: 5 }],
    };
    const plan = planImportGrouping({
      ...base,
      projects,
      folders: emptyFoldersFile(),
      entries: [{ sessionId: "pi:1", group: hint("/src/app") }],
    });
    expect(plan.projects.projects).toHaveLength(1);
    expect(plan.projects.chats["pi:1"]).toBe("pexisting1");
    expect(plan.outcomes[0]).toMatchObject({ name: "My renamed app", created: false, added: 1 });
  });

  it("leaves a chat the person placed, and moves one the sorting placed", () => {
    const folders = {
      ...emptyFoldersFile(),
      folders: [
        { id: "fmine", name: "Work", collapsed: false },
        { id: "fauto", name: "app", collapsed: false },
      ],
      chats: { "claude-code:mine": "fmine", "claude-code:auto": "fauto" } as Record<string, string | null>,
      projects: { fauto: "/src/app" },
      auto: { "claude-code:auto": true } as Record<string, true>,
    };
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders,
      entries: [
        { sessionId: "claude-code:mine", group: hint("/src/app") },
        { sessionId: "claude-code:auto", group: hint("/src/app") },
      ],
    });
    expect(plan.folders.chats["claude-code:mine"]).toBe("fmine");
    expect(plan.projects.chats["claude-code:mine"]).toBeUndefined();
    expect(plan.projects.chats["claude-code:auto"]).toBeDefined();
    expect(plan.outcomes[0]).toMatchObject({ added: 1, kept: 1 });
    // "app" is empty now but the grouping did not make it: it stays.
    expect(plan.folders.folders.map((f) => f.id)).toEqual(["fmine", "fauto"]);
    expect(plan.folders.projects.fauto).toBe("/src/app");
  });

  it("never rebinds or deletes the person's own folder with a group's name", () => {
    const folders = {
      ...emptyFoldersFile(),
      folders: [{ id: "fmine", name: "Research", collapsed: false }],
      chats: { "claude-app:mine": "fmine" } as Record<string, string | null>,
    };
    const research = namedGroupHint("claude-app:project:u1", "Research")!;
    const first = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders,
      entries: [{ sessionId: "claude-app:new", group: research }],
    });
    // A folder of its own, not the person's.
    expect(first.folders.projects.fmine).toBeUndefined();
    const made = first.folders.folders.find((f) => f.id !== "fmine")!;
    expect(made.name).toBe("Research (imported)");
    expect(first.folders.imported).toEqual({ [made.id]: true });
    expect(first.folders.chats["claude-app:new"]).toBe(made.id);
    expect(first.folders.chats["claude-app:mine"]).toBe("fmine");

    // Later the desktop's sorting files a chat into the person's folder as
    // automatic, and an import moves it into a project: the folder stays.
    const later = {
      ...first.folders,
      chats: { ...first.folders.chats, "claude-code:x": "fmine", "claude-app:mine": null },
      auto: { "claude-code:x": true } as Record<string, true>,
    };
    const second = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders: later,
      entries: [{ sessionId: "claude-code:x", group: hint("/src/app") }],
    });
    expect(second.projects.chats["claude-code:x"]).toBeDefined();
    expect(second.folders.folders.map((f) => f.id)).toContain("fmine");
    expect(second.folders.projects.fmine).toBeUndefined();
  });

  it("still removes a folder it created itself once a run empties it", () => {
    const folders = {
      ...emptyFoldersFile(),
      folders: [
        { id: "fmine", name: "Work", collapsed: false },
        { id: "fimp", name: "app", collapsed: false },
      ],
      chats: { "claude-code:auto": "fimp" } as Record<string, string | null>,
      projects: { fimp: "/src/app" },
      auto: { "claude-code:auto": true } as Record<string, true>,
      imported: { fimp: true } as Record<string, true>,
    };
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders,
      entries: [{ sessionId: "claude-code:auto", group: hint("/src/app") }],
    });
    expect(plan.projects.chats["claude-code:auto"]).toBeDefined();
    expect(plan.folders.folders.map((f) => f.id)).toEqual(["fmine"]);
    expect(plan.folders.projects.fimp).toBeUndefined();
    expect(plan.folders.imported).toBeUndefined();
  });

  it("reuses a folder it created itself by name", () => {
    const folders = {
      ...emptyFoldersFile(),
      folders: [{ id: "fimp", name: "Research", collapsed: false }],
      imported: { fimp: true } as Record<string, true>,
    };
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders,
      entries: [{ sessionId: "claude-app:1", group: namedGroupHint("claude-app:project:u1", "Research")! }],
    });
    expect(plan.folders.folders).toHaveLength(1);
    expect(plan.folders.projects.fimp).toBe("claude-app:project:u1");
    expect(plan.folders.chats["claude-app:1"]).toBe("fimp");
  });

  it("does nothing when the person turned the sorting off", () => {
    const plan = planImportGrouping({
      ...base,
      projects: emptyProjectsFile(),
      folders: { ...emptyFoldersFile(), autoSort: false },
      entries: [{ sessionId: "x:1", group: hint("/src/app") }],
    });
    expect(plan.off).toBeTruthy();
    expect(plan.outcomes).toEqual([]);
    expect(plan.projectsChanged || plan.foldersChanged).toBe(false);
  });

  it("W2 QA: makes no folder for a gone folder whose chats are all in a project already", () => {
    const first = planImportGrouping({ ...base, projects: emptyProjectsFile(), folders: emptyFoldersFile(),
      entries: [{ sessionId: "claude-code:a", group: hint("/src/app") }] });
    const gone = planImportGrouping({ ...base, isDir: () => false, projects: first.projects, folders: first.folders,
      entries: [{ sessionId: "claude-code:a", group: hint("/src/app") }] });
    expect(gone.folders.folders).toHaveLength(0);
    expect(gone.outcomes[0]).toMatchObject({ kind: "folder", added: 0, kept: 1 });
  });

  it("keeps a named group with no chats as an empty folder, once", () => {
    const entries = [{ sessionId: "", group: namedGroupHint("claude-app:project:u1", "Research")! }];
    const first = planImportGrouping({ ...base, projects: emptyProjectsFile(), folders: emptyFoldersFile(), entries });
    expect(first.outcomes).toEqual([
      { kind: "folder", name: "Research", path: null, created: true, chats: 0, added: 0, kept: 0 },
    ]);
    const second = planImportGrouping({ ...base, projects: first.projects, folders: first.folders, entries });
    expect(second.folders.folders).toHaveLength(1);
    expect(second.outcomes[0]!.created).toBe(false);
  });
});

describe("groupImportReport", () => {
  let root: string;
  let stateDir: string;
  let workDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "import-grouping-"));
    stateDir = join(root, "state");
    workDir = join(root, "src", "shop");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function report(): ImportReport<string> {
    const items: ImportItemResult<string>[] = [
      { kind: "sessions", source: "1", destination: "codex:1", status: "migrated", group: hint(workDir) },
      { kind: "sessions", source: "2", destination: "codex:2", status: "skipped", reason: "already matches", group: hint("/nowhere/blog") },
      { kind: "sessions", source: "3", destination: "codex:3", status: "error", group: hint(workDir) },
      { kind: "skills", source: "s", status: "migrated" },
    ];
    return buildReport(items, false);
  }

  it("previews the groups without writing, then writes them, then finds them in place", () => {
    const preview = groupImportReport(report(), { stateDir, execute: false });
    expect(preview.items.slice(4)).toEqual([
      { kind: "projects", source: "shop", destination: workDir, status: "migrated", reason: "new project; 1 chat; 1 added" },
      { kind: "folders", source: "blog", destination: "/nowhere/blog", status: "migrated", reason: "new folder; 1 chat; 1 added" },
    ]);
    expect(preview.summary.migrated).toBe(4);
    expect(() => readFileSync(join(stateDir, "projects.json"))).toThrow();

    groupImportReport(report(), { stateDir, execute: true });
    const projects = JSON.parse(readFileSync(join(stateDir, "projects.json"), "utf8"));
    expect(projects.projects).toHaveLength(1);
    expect(projects.chats).toEqual({ "codex:1": projects.projects[0].id });
    const folders = JSON.parse(readFileSync(join(stateDir, "chat-folders.json"), "utf8"));
    expect(folders.folders.map((f: { name: string }) => f.name)).toEqual(["blog"]);
    expect(folders.chats["codex:3"]).toBeUndefined();

    const again = groupImportReport(report(), { stateDir, execute: true });
    expect(again.items.slice(4).map((i) => [i.status, i.reason])).toEqual([
      ["skipped", "existing project; 1 chat; already in place"],
      ["skipped", "existing folder; 1 chat; already in place"],
    ]);
    expect(JSON.parse(readFileSync(join(stateDir, "projects.json"), "utf8"))).toEqual(projects);
  });

  it("reports a folders file it cannot read instead of writing over it", () => {
    writeFileSync(join(stateDir, "chat-folders.json"), "{ not json");
    const out = groupImportReport(report(), { stateDir, execute: true });
    expect(out.items[4]).toMatchObject({ kind: "folders", status: "error" });
    expect(readFileSync(join(stateDir, "chat-folders.json"), "utf8")).toBe("{ not json");
  });

  it("leaves a report with no hints as it was", () => {
    const plain = buildReport<string>([{ kind: "skills", source: "s", status: "migrated" }], true);
    expect(groupImportReport(plain, { stateDir, execute: true })).toBe(plain);
  });
});

describe("mergeGroupingFrom", () => {
  it("brings another state dir's projects and folders as they were, once", () => {
    const source = {
      projects: {
        ...emptyProjectsFile(),
        projects: [{ id: "psource01", name: "Shop", folder: "/src/shop", instructions: "use pnpm", createdAt: 7 }],
        chats: { s1: "psource01", s9: "psource01" },
      },
      folders: {
        ...emptyFoldersFile(),
        folders: [{ id: "fideas", name: "Ideas", collapsed: true }],
        chats: { s2: "fideas", s3: null } as Record<string, string | null>,
      },
    };
    const target = {
      projects: emptyProjectsFile(),
      folders: { ...emptyFoldersFile(), chats: { s2: null } as Record<string, string | null> },
    };
    const plan = mergeGroupingFrom({ source, target, sessionIds: new Set(["s1", "s2", "s3"]) });
    expect(plan.projects.projects).toEqual([source.projects.projects[0]]);
    expect(plan.projects.chats).toEqual({ s1: "psource01" });
    expect(plan.folders.folders).toEqual([{ id: "fideas", name: "Ideas", collapsed: true }]);
    // s2 was taken out of every folder here: that stays.
    expect(plan.folders.chats).toEqual({ s2: null, s3: null });
    expect(plan.outcomes).toEqual([
      { kind: "project", name: "Shop", path: "/src/shop", created: true, chats: 1, added: 1, kept: 0 },
      { kind: "folder", name: "Ideas", path: null, created: true, chats: 1, added: 0, kept: 1 },
    ]);
    const again = mergeGroupingFrom({
      source,
      target: { projects: plan.projects, folders: plan.folders },
      sessionIds: new Set(["s1", "s2", "s3"]),
    });
    expect(again.projectsChanged || again.foldersChanged).toBe(false);
  });
});

describe("coerceFoldersFile", () => {
  it("keeps a folder's instructions and creation time (the desktop draws it as a project)", () => {
    const f = coerceFoldersFile({
      folders: [
        { id: "fa", name: "Marketing", instructions: "  Be brief ", createdAt: 7 },
        { id: "fb", name: "B", instructions: 3, createdAt: "x" },
      ],
    });
    expect(f.folders).toEqual([
      { id: "fa", name: "Marketing", collapsed: false, instructions: "Be brief", createdAt: 7 },
      { id: "fb", name: "B", collapsed: false },
    ]);
  });
});
