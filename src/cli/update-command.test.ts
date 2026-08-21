import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppUpdateCheckError,
  AppUpdateError,
  type AppUpdateCheckResult,
} from "../update/index.js";
import {
  updateCommand,
  type UpdateCommandDeps,
} from "./update-command.js";

function makeResult(
  overrides: Partial<AppUpdateCheckResult> = {},
): AppUpdateCheckResult {
  return {
    updateAvailable: true,
    currentVersion: "0.3.1",
    latestTag: "v0.3.2",
    latestVersion: "0.3.2",
    ...overrides,
  };
}

describe("atomic-agent update", () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let deps: Required<UpdateCommandDeps>;

  const runInstaller = vi.fn();
  const check = vi.fn();
  const canSelfUpdate = vi.fn();

  beforeEach(() => {
    stdoutChunks = [];
    stderrChunks = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
    runInstaller.mockReset();
    check.mockReset();
    canSelfUpdate.mockReset();
    deps = {
      checkForAppUpdate: check,
      runAppUpdate: runInstaller,
      canSelfUpdate,
      getRepo: () => "AtomicBot-ai/atomic-agent",
      isTTY: () => false,
      confirm: async () => true,
    };
    check.mockResolvedValue(makeResult());
    canSelfUpdate.mockReturnValue(true);
    runInstaller.mockResolvedValue({ ok: true, installDir: "/tmp/install" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutChunks.join("");
  }

  function stderr(): string {
    return stderrChunks.join("");
  }

  it("prints help and exits 0 for -h and --help", async () => {
    expect(await updateCommand(["-h"], deps)).toBe(0);
    expect(await updateCommand(["--help"], deps)).toBe(0);
    expect(stdout()).toMatch(/atomic-agent update/);
    expect(stdout()).toMatch(/--check/);
    expect(stdout()).toMatch(/--yes/);
    expect(check).not.toHaveBeenCalled();
  });

  it("exits 2 for an unknown flag", async () => {
    expect(await updateCommand(["--bogus"], deps)).toBe(2);
    expect(stderr()).toMatch(/unknown option: --bogus/);
    expect(check).not.toHaveBeenCalled();
  });

  it("exits 2 for --version without a value", async () => {
    expect(await updateCommand(["--version"], deps)).toBe(2);
    expect(stderr()).toMatch(/--version requires a tag/);
  });

  it("exits 2 when --check is combined with --version", async () => {
    expect(await updateCommand(["--check", "--version", "v0.3.2"], deps)).toBe(
      2,
    );
    expect(stderr()).toMatch(/--check and --version are mutually exclusive/);
  });

  it("--check reports up to date and exits 0 without installing", async () => {
    check.mockResolvedValue(
      makeResult({ updateAvailable: false, latestTag: "v0.3.1", latestVersion: "0.3.1" }),
    );
    expect(await updateCommand(["--check"], deps)).toBe(0);
    expect(stdout()).toMatch(/up to date \(0\.3\.1\)/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("--check reports the newer version and exits 0 without installing", async () => {
    expect(await updateCommand(["--check"], deps)).toBe(0);
    expect(stdout()).toMatch(/update available: 0\.3\.1 → 0\.3\.2/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("--check exits 1 when the check itself fails", async () => {
    check.mockRejectedValue(new AppUpdateCheckError("HTTP 403", 403));
    expect(await updateCommand(["--check"], deps)).toBe(1);
    expect(stderr()).toMatch(/HTTP 403/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("refuses to self-update in a dev build, exiting 1", async () => {
    canSelfUpdate.mockReturnValue(false);
    expect(await updateCommand([], deps)).toBe(1);
    expect(stderr()).toMatch(/installed binary/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("reports up to date and exits 0 without installing when current", async () => {
    check.mockResolvedValue(
      makeResult({ updateAvailable: false, latestTag: "v0.3.1", latestVersion: "0.3.1" }),
    );
    expect(await updateCommand([], deps)).toBe(0);
    expect(stdout()).toMatch(/up to date \(0\.3\.1\)/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("refuses non-TTY update without --yes, exiting 1", async () => {
    expect(await updateCommand([], deps)).toBe(1);
    expect(stderr()).toMatch(/non-interactive.*--yes/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("refuses non-TTY --version without --yes, exiting 1", async () => {
    expect(await updateCommand(["--version", "v0.3.2"], deps)).toBe(1);
    expect(stderr()).toMatch(/non-interactive.*--yes/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("updates in place with --yes in non-TTY", async () => {
    expect(await updateCommand(["--yes"], deps)).toBe(0);
    expect(stdout()).toMatch(/current: 0\.3\.1 → latest: 0\.3\.2/);
    expect(runInstaller).toHaveBeenCalledTimes(1);
    expect(runInstaller).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "AtomicBot-ai/atomic-agent",
        version: undefined,
      }),
    );
    expect(stdout()).toMatch(/updated to 0\.3\.2/);
  });

  it("short flag -y works the same as --yes", async () => {
    expect(await updateCommand(["-y"], deps)).toBe(0);
    expect(runInstaller).toHaveBeenCalledTimes(1);
  });

  it("--yes skips the interactive prompt in TTY", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await updateCommand(["--yes"], { ...deps, isTTY: () => true, confirm })).toBe(
      0,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(runInstaller).toHaveBeenCalledTimes(1);
  });

  it("streams installer lines prefixed with [update]", async () => {
    runInstaller.mockImplementation(
      async (opts?: { onLine?: (line: string) => void }) => {
        opts?.onLine?.("downloading atomic-agent");
        opts?.onLine?.("installed atomic-agent to /tmp/install");
        return { ok: true, installDir: "/tmp/install" };
      },
    );
    expect(await updateCommand(["--yes"], deps)).toBe(0);
    expect(stdout()).toMatch(/\[update\] downloading atomic-agent/);
    expect(stdout()).toMatch(/\[update\] installed atomic-agent/);
  });

  it("prompts in an interactive terminal and cancels on 'no'", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    expect(await updateCommand([], { ...deps, isTTY: () => true, confirm })).toBe(
      0,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("update to 0.3.2? [y/N] ");
    expect(stdout()).toMatch(/update cancelled/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("proceeds when the interactive prompt is accepted", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    expect(await updateCommand([], { ...deps, isTTY: () => true, confirm })).toBe(
      0,
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runInstaller).toHaveBeenCalledTimes(1);
  });

  it("exits 1 and reports the installer failure", async () => {
    runInstaller.mockRejectedValue(
      new AppUpdateError("install script exited with code 7"),
    );
    expect(await updateCommand(["--yes"], deps)).toBe(1);
    expect(stderr()).toMatch(/install script exited with code 7/);
    expect(stdout()).not.toMatch(/updated to/);
  });

  it("--version pins a specific tag with --yes", async () => {
    check.mockResolvedValue(
      makeResult({ updateAvailable: false, latestTag: "v0.3.1", latestVersion: "0.3.1" }),
    );
    expect(await updateCommand(["--version", "v0.3.2", "--yes"], deps)).toBe(0);
    expect(stdout()).toMatch(/installing v0\.3\.2/);
    expect(runInstaller).toHaveBeenCalledWith(
      expect.objectContaining({ version: "v0.3.2" }),
    );
  });

  it("--version refuses non-TTY without --yes", async () => {
    expect(await updateCommand(["--version", "v0.3.2"], deps)).toBe(1);
    expect(stderr()).toMatch(/non-interactive.*--yes/);
    expect(runInstaller).not.toHaveBeenCalled();
  });

  it("--version proceeds in TTY without --yes", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    expect(
      await updateCommand(["--version", "v0.3.2"], { ...deps, isTTY: () => true, confirm }),
    ).toBe(0);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(runInstaller).toHaveBeenCalledTimes(1);
  });
});
