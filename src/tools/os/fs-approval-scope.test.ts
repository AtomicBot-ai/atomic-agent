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

  // No trust-config paths by default so the scope/category tests stay
  // pure; the trust-config guard has its own block below.
  const opts = () => ({
    workingDir: workspace,
    homeDir: home,
    trustConfigPaths: [] as string[],
  });

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

  it("C2: a DANGLING symlink in the workspace pointing outside classifies by target (asks)", async () => {
    // Broken link leak.txt -> /elsewhere/ghost.txt (target does not
    // exist). realpath(leak.txt) throws ENOENT; the naive
    // deepest-existing-ancestor fallback would re-glue the leaf to the
    // workspace and call it "workspace" (silent at L2) even though
    // writeFile through the link creates the file OUTSIDE. We must
    // classify by the link target.
    const danglingOut = join(workspace, "leak.txt");
    await symlink(join(elsewhere, "ghost.txt"), danglingOut);
    expect(await resolveFsScope([danglingOut], opts())).toBe("outside");
    expect(await categorizeFsMutation("write", [danglingOut], opts())).toBe(
      "other",
    );
  });

  it("C2: a dangling symlink to a not-yet-existing file INSIDE the workspace stays workspace", async () => {
    // The legitimate case: a link to a workspace file that has not been
    // created yet must still be a workspace write (silent at L2).
    const danglingIn = join(workspace, "pending.txt");
    await symlink(join(workspace, "sub", "new.txt"), danglingIn);
    expect(await resolveFsScope([danglingIn], opts())).toBe("workspace");
    expect(await categorizeFsMutation("write", [danglingIn], opts())).toBe(
      "fs_write_workspace",
    );
  });

  it("C2: a chain of dangling symlinks is followed to where the write lands", async () => {
    // a -> b -> /elsewhere/ghost.txt, none existing: still outside.
    await symlink(join(workspace, "b.txt"), join(workspace, "a.txt"));
    await symlink(join(elsewhere, "ghost.txt"), join(workspace, "b.txt"));
    expect(await resolveFsScope([join(workspace, "a.txt")], opts())).toBe(
      "outside",
    );
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
        trustConfigPaths: [],
      }),
    ).toBe("outside");
  });

  describe("C1: trust-config guard (config.json / .env)", () => {
    // The state dir sits under home in production, so config.json would
    // otherwise be fs_write_home (silent at L3) and a model at L3/L4
    // could rewrite its own approvalLevel to 5 with no prompt.
    let stateDir: string;
    let configFile: string;
    let envFile: string;

    beforeEach(async () => {
      stateDir = join(home, ".atomic-agent");
      configFile = join(stateDir, "config.json");
      envFile = join(stateDir, ".env");
      await mkdir(stateDir, { recursive: true });
      await writeFile(configFile, "{}", "utf8");
      await writeFile(envFile, "SECRET=1", "utf8");
    });

    const trustOpts = () => ({
      workingDir: workspace,
      homeDir: home,
      trustConfigPaths: [configFile, envFile],
    });

    it("write/edit/patch to config.json is trust_config (asks until L5)", async () => {
      expect(await categorizeFsMutation("write", [configFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("write to .env (API tokens) is trust_config too", async () => {
      expect(await categorizeFsMutation("write", [envFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("trashing the config file is a trust mutation as well", async () => {
      expect(await categorizeFsMutation("trash", [configFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("a batch that includes config.json is trust_config even alongside a plain file", async () => {
      expect(
        await categorizeFsMutation(
          "write",
          [join(workspace, "ok.txt"), configFile],
          trustOpts(),
        ),
      ).toBe("trust_config");
    });

    it("catches a symlink detour to config.json (compared on realpath, not string)", async () => {
      const decoy = join(workspace, "innocent.json");
      await symlink(configFile, decoy);
      expect(await categorizeFsMutation("write", [decoy], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("catches a `..` path that resolves to config.json", async () => {
      const detour = join(stateDir, "sub", "..", "config.json");
      await mkdir(join(stateDir, "sub"), { recursive: true });
      expect(await categorizeFsMutation("write", [detour], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("a not-yet-existing .env on a fresh install still matches", async () => {
      await rm(envFile, { force: true });
      expect(await categorizeFsMutation("write", [envFile], trustOpts())).toBe(
        "trust_config",
      );
    });

    it("a normal file next to config.json is NOT trust_config", async () => {
      expect(
        await categorizeFsMutation(
          "write",
          [join(stateDir, "notes.txt")],
          trustOpts(),
        ),
      ).toBe("fs_write_home");
    });

    it("extraction never inherits the trust-config guard (targets a dir)", async () => {
      // Even if destDir is the state dir, extract stays on the scope
      // ladder; the guard only fires for write/trash of the exact file.
      expect(await categorizeFsMutation("extract", [stateDir], trustOpts())).toBe(
        "fs_write_home",
      );
    });
  });
});
