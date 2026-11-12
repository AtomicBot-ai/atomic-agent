import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  isInIgnoredDir,
  matchesTriggerGlob,
  resolveTriggerRoot,
} from "./file-trigger-guard.js";
import { renderFileTriggerTemplate } from "./file-trigger-template.js";

const HOME = resolve("/home/user");

describe("resolveTriggerRoot", () => {
  it("expands ~ and allows folders and files inside home", () => {
    expect(resolveTriggerRoot("~/Inbox", HOME)).toEqual({ ok: true, path: join(HOME, "Inbox") });
    expect(resolveTriggerRoot(join(HOME, "logs", "app.log"), HOME)).toEqual({
      ok: true,
      path: join(HOME, "logs", "app.log"),
    });
  });

  it("allows paths outside home", () => {
    expect(resolveTriggerRoot(resolve("/var/log/app.log"), HOME)).toEqual({
      ok: true,
      path: resolve("/var/log/app.log"),
    });
  });

  it.each([
    ["the home dir", "~"],
    ["the home dir with a slash", "~/"],
    ["the home dir spelled out", HOME],
    ["a parent of home", resolve("/home")],
    ["the filesystem root", resolve("/")],
  ])("refuses %s", (_label, raw) => {
    expect(resolveTriggerRoot(raw, HOME).ok).toBe(false);
  });

  it("refuses a relative path", () => {
    expect(resolveTriggerRoot("Inbox", HOME).ok).toBe(false);
  });

  it("does not mistake a sibling with a common prefix for a parent", () => {
    expect(resolveTriggerRoot(resolve("/home/user2"), HOME).ok).toBe(true);
  });
});

describe("ignored dirs and globs", () => {
  const root = join(HOME, "Inbox");

  it("skips node_modules and .git at any depth", () => {
    expect(isInIgnoredDir(root, join(root, "node_modules"))).toBe(true);
    expect(isInIgnoredDir(root, join(root, "a", ".git", "HEAD"))).toBe(true);
    expect(isInIgnoredDir(root, join(root, "a", "b.pdf"))).toBe(false);
    expect(isInIgnoredDir(root, root)).toBe(false);
  });

  it("matches the glob against the path relative to the root", () => {
    expect(matchesTriggerGlob(root, join(root, "doc.pdf"), "*.pdf")).toBe(true);
    expect(matchesTriggerGlob(root, join(root, "doc.txt"), "*.pdf")).toBe(false);
    expect(matchesTriggerGlob(root, join(root, "sub", "doc.pdf"), "*.pdf")).toBe(false);
    expect(matchesTriggerGlob(root, join(root, "sub", "doc.pdf"), "**/*.pdf")).toBe(true);
    expect(matchesTriggerGlob(root, join(root, "anything"), undefined)).toBe(true);
  });
});

describe("renderFileTriggerTemplate", () => {
  const vars = {
    path: "/in/a.pdf",
    relativePath: "a.pdf",
    name: "a.pdf",
    event: "add",
    trigger: "inbox",
    lines: "",
  };

  it("fills known placeholders and blanks unknown ones", () => {
    expect(renderFileTriggerTemplate("{{ event }} {{path}} ({{trigger}}) {{nope}}.", vars)).toBe(
      "add /in/a.pdf (inbox) .",
    );
  });

  it("keeps an escaped placeholder literal", () => {
    expect(renderFileTriggerTemplate("\\{{path}} {{name}}", vars)).toBe("{{path}} a.pdf");
  });

  it("does not read inherited keys", () => {
    expect(renderFileTriggerTemplate("{{constructor}}", vars)).toBe("");
  });
});
