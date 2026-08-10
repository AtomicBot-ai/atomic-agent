import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { categorizeFsMutation, resolveFsScope } from "./fs-approval-scope.js";

describe("fs approval scope", () => {
  let root: string;
  let workspace: string;
  let home: string;
  let elsewhere: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fs-scope-"));
    workspace = join(root, "workspace");
    home = join(root, "home");
    elsewhere = join(root, "elsewhere");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const opts = () => ({ workingDir: workspace, homeDir: home });

  it("classifies existing and not-yet-existing paths inside the workspace", async () => {
    await writeFile(join(workspace, "a.txt"), "x", "utf8");
    expect(await resolveFsScope([join(workspace, "a.txt")], opts())).toBe(
      "workspace",
    );
    // fs.write creates files: the leaf (and even parents) may not exist yet.
    expect(
      await resolveFsScope([join(workspace, "new", "deep", "b.txt")], opts()),
    ).toBe("workspace");
    // The workspace root itself counts as inside.
    expect(await resolveFsScope([workspace], opts())).toBe("workspace");
  });

  it("classifies home and outside paths", async () => {
    expect(await resolveFsScope([join(home, "notes.txt")], opts())).toBe(
      "home",
    );
    expect(await resolveFsScope([join(elsewhere, "x.txt")], opts())).toBe(
      "outside",
    );
    // Prefix trick: /root/home-evil must not match /root/home.
    expect(
      await resolveFsScope([`${home}-evil/notes.txt`], opts()),
    ).toBe("outside");
  });

  it("a symlink inside the workspace that points outside is NOT workspace", async () => {
    await symlink(elsewhere, join(workspace, "link-out"));
    expect(
      await resolveFsScope([join(workspace, "link-out", "f.txt")], opts()),
    ).toBe("outside");
    await symlink(join(home, "sub"), join(workspace, "link-home"));
    await mkdir(join(home, "sub"), { recursive: true });
    expect(
      await resolveFsScope([join(workspace, "link-home", "f.txt")], opts()),
    ).toBe("home");
  });

  it("a symlinked workspace root still contains its own files (realpath both sides)", async () => {
    const linkedWorkspace = join(root, "ws-link");
    await symlink(workspace, linkedWorkspace);
    expect(
      await resolveFsScope([join(workspace, "f.txt")], {
        workingDir: linkedWorkspace,
        homeDir: home,
      }),
    ).toBe("workspace");
  });

  it("combines multiple paths to the weakest scope", async () => {
    expect(
      await resolveFsScope(
        [join(workspace, "a"), join(home, "b")],
        opts(),
      ),
    ).toBe("home");
    expect(
      await resolveFsScope(
        [join(workspace, "a"), join(elsewhere, "b")],
        opts(),
      ),
    ).toBe("outside");
    expect(await resolveFsScope([], opts())).toBe("outside");
  });

  it("relative segments are expected pre-resolved; resolve() output classifies correctly", async () => {
    // Tools hand in resolveUserPath() output (absolute, lexically
    // collapsed) — mirror that here.
    const collapsed = resolve(workspace, "sub", "..", "c.txt");
    expect(await resolveFsScope([collapsed], opts())).toBe("workspace");
  });

  it("maps write/trash/extract kinds onto the ladder categories", async () => {
    const ws = join(workspace, "f.txt");
    const hm = join(home, "f.txt");
    const out = join(elsewhere, "f.txt");

    expect(await categorizeFsMutation("write", [ws], opts())).toBe(
      "fs_write_workspace",
    );
    expect(await categorizeFsMutation("write", [hm], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("write", [out], opts())).toBe("other");

    // Trash goes silent at level 3 even for workspace paths: level 2
    // deliberately covers plain writes only.
    expect(await categorizeFsMutation("trash", [ws], opts())).toBe("fs_trash");
    expect(await categorizeFsMutation("trash", [hm], opts())).toBe("fs_trash");
    expect(await categorizeFsMutation("trash", [out], opts())).toBe("other");

    // Extraction materialises unreviewed archive content: level 3 even
    // when the destination is the workspace.
    expect(await categorizeFsMutation("extract", [ws], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("extract", [hm], opts())).toBe(
      "fs_write_home",
    );
    expect(await categorizeFsMutation("extract", [out], opts())).toBe("other");
  });

  it("falls back to outside (asks) when the workspace root itself is unresolvable", async () => {
    expect(
      await resolveFsScope([join(workspace, "f.txt")], {
        workingDir: join(root, "does-not-exist"),
        homeDir: home,
      }),
    ).toBe("outside");
  });
});
