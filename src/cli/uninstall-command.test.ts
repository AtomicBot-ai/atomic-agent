import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedUninstallPlan } from "../uninstall/index.js";
import {
  uninstallCommand,
  type UninstallCommandDeps,
} from "./uninstall-command.js";

function makePlan(
  overrides: Partial<ResolvedUninstallPlan> = {},
): ResolvedUninstallPlan {
  const targets = [
    {
      path: "/Users/op/.atomic-agent",
      label: "config, memory, sessions",
      group: "data" as const,
    },
    {
      path: "/Users/op/.local/bin/atomic-agent",
      label: "the binary",
      group: "program" as const,
    },
  ];
  return {
    targets,
    measured: {
      targets: targets.map((t) => ({ ...t, exists: true, bytes: 1024 })),
      totalBytes: 2048,
    },
    devCheckout: false,
    installDir: "/Users/op/.local/bin",
    ...overrides,
  };
}

describe("atomic-agent uninstall", () => {
  let out: string[];
  let err: string[];
  let deps: UninstallCommandDeps;
  const run = vi.fn();
  const resolvePlan = vi.fn();
  const ask = vi.fn();

  beforeEach(() => {
    out = [];
    err = [];
    run.mockReset();
    resolvePlan.mockReset();
    ask.mockReset();
    run.mockResolvedValue({ removed: [], rcFilesEdited: [], complete: true });
    resolvePlan.mockResolvedValue(makePlan());
    ask.mockResolvedValue("uninstall");
    deps = {
      resolvePlan: resolvePlan as unknown as UninstallCommandDeps["resolvePlan"],
      run: run as unknown as UninstallCommandDeps["run"],
      getStateDir: () => "/Users/op/.atomic-agent",
      isTTY: () => true,
      ask,
      write: (text) => void out.push(text),
      writeErr: (text) => void err.push(text),
    };
  });

  const stdout = (): string => out.join("");
  const stderr = (): string => err.join("");

  it("prints the plan with sizes before asking anything", async () => {
    await uninstallCommand([], deps);
    expect(stdout()).toContain("/Users/op/.atomic-agent");
    expect(stdout()).toContain("1 KB");
    expect(stdout()).toContain("total: 2 KB");
  });

  it("warns that the removal is permanent", async () => {
    await uninstallCommand([], deps);
    expect(stdout()).toContain("THIS CANNOT BE UNDONE");
  });

  it("requires the word, not a y", async () => {
    ask.mockResolvedValue("y");
    const code = await uninstallCommand([], deps);
    expect(code).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(stdout()).toContain("cancelled");
  });

  it("removes once the word is typed", async () => {
    const code = await uninstallCommand([], deps);
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].targets).toHaveLength(2);
    expect(stdout()).toContain("uninstalled");
  });

  it("accepts the word with stray case and whitespace", async () => {
    ask.mockResolvedValue("  UNINSTALL \n");
    await uninstallCommand([], deps);
    expect(run).toHaveBeenCalledOnce();
  });

  it("removes nothing under --dry-run and never asks", async () => {
    const code = await uninstallCommand(["--dry-run"], deps);
    expect(code).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(stdout()).toContain("dry run");
  });

  it("refuses to run unattended without --yes", async () => {
    deps.isTTY = () => false;
    const code = await uninstallCommand([], deps);
    expect(code).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(stderr()).toContain("--yes");
  });

  it("runs unattended with --yes", async () => {
    deps.isTTY = () => false;
    const code = await uninstallCommand(["--yes"], deps);
    expect(code).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
  });

  it("passes --keep-data and --keep-binary through to the planner", async () => {
    await uninstallCommand(["--keep-data", "--yes"], deps);
    expect(resolvePlan.mock.calls[0]?.[0]).toMatchObject({ keepData: true });
    resolvePlan.mockClear();
    await uninstallCommand(["--keep-binary", "--yes"], deps);
    expect(resolvePlan.mock.calls[0]?.[0]).toMatchObject({ keepBinary: true });
  });

  it("rejects the two --keep flags together", async () => {
    const code = await uninstallCommand(["--keep-data", "--keep-binary"], deps);
    expect(code).toBe(2);
    expect(stderr()).toContain("would remove nothing");
  });

  it("skips the permanence warning under --keep-data", async () => {
    await uninstallCommand(["--keep-data", "--yes"], deps);
    expect(stdout()).not.toContain("THIS CANNOT BE UNDONE");
  });

  it("rejects an unknown flag", async () => {
    const code = await uninstallCommand(["--force"], deps);
    expect(code).toBe(2);
    expect(stderr()).toContain("unknown option: --force");
  });

  it("says so and exits 0 when nothing is installed", async () => {
    resolvePlan.mockResolvedValue(
      makePlan({ targets: [], measured: { targets: [], totalBytes: 0 } }),
    );
    const code = await uninstallCommand([], deps);
    expect(code).toBe(0);
    expect(stdout()).toContain("not installed here");
    expect(run).not.toHaveBeenCalled();
  });

  it("names the dev checkout instead of pretending to remove a binary", async () => {
    resolvePlan.mockResolvedValue(makePlan({ devCheckout: true }));
    await uninstallCommand(["--dry-run"], deps);
    expect(stdout()).toContain("dev checkout");
    expect(stdout()).toContain("/Users/op/.local/bin");
  });

  it("reports every failed target and exits 1", async () => {
    run.mockResolvedValue({
      removed: [
        { path: "/a", ok: true },
        { path: "/b", ok: false, error: "EPERM" },
      ],
      rcFilesEdited: [],
      complete: false,
    });
    const code = await uninstallCommand(["--yes"], deps);
    expect(code).toBe(1);
    expect(stderr()).toContain("could not remove /b: EPERM");
    expect(stderr()).toContain("1 of 2 targets");
  });

  it("tells the operator their PATH needs a fresh shell", async () => {
    run.mockResolvedValue({
      removed: [],
      rcFilesEdited: ["/Users/op/.zshrc"],
      complete: true,
    });
    await uninstallCommand(["--yes"], deps);
    expect(stdout()).toContain("/Users/op/.zshrc");
    expect(stdout()).toContain("new shell");
  });

  it("documents itself under --help without touching anything", async () => {
    const code = await uninstallCommand(["--help"], deps);
    expect(code).toBe(0);
    expect(resolvePlan).not.toHaveBeenCalled();
    expect(stdout()).toContain("--dry-run");
    expect(stdout()).toContain("cannot be undone");
  });
});
