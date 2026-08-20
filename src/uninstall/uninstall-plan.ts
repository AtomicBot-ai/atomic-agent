import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * What an uninstall may remove. The split mirrors what the installers
 * actually write (see `scripts/install.sh` / `scripts/install.ps1`),
 * not an invented taxonomy:
 *
 *   - `app`   the binary plus the six asset trees dropped beside it
 *   - `path`  the `export PATH=...` block appended to a shell rc file
 *   - `state` the state directory: config, sessions, memory, secrets,
 *             and any downloaded model weights
 *
 * `app` and `path` together undo the install. `state` is what erases the
 * user's data, so it is never implied — it must be asked for by name or
 * via `--all`. This is the same default Hermes and OpenClaw settle on:
 * removing the program does not destroy the work done with it.
 */
export type UninstallScope = "app" | "path" | "state";

export const UNINSTALL_SCOPES: readonly UninstallScope[] = [
  "app",
  "path",
  "state",
];

/** Scopes selected when the operator names none. */
export const DEFAULT_UNINSTALL_SCOPES: readonly UninstallScope[] = [
  "app",
  "path",
];

/**
 * Asset trees the installer lays down as siblings of the binary. Kept as
 * an explicit list rather than "delete the install dir" on purpose — see
 * {@link isSharedInstallDir}.
 */
export const INSTALLED_ASSET_DIRS: readonly string[] = [
  "grammars",
  "starter-skills",
  "assets",
  "vendor",
  "prebuilds",
  "node_modules",
];

/** Binary names the installer may have written, POSIX and Windows. */
export const INSTALLED_BINARY_NAMES: readonly string[] = [
  "atomic-agent",
  "atomic-agent.exe",
  // Short alias installed alongside the binary since v0.3.2 (#195).
  "atag",
  "atag.exe",
];

/** The comment the installer writes above the PATH line it appends. */
export const PATH_MARKER = "# added by atomic-agent installer";

/**
 * Shell rc files the installer may have edited, by shell. Mirrors the
 * `case "$_shell_name"` block in `install.sh`.
 */
export function candidateShellRcFiles(home: string): readonly string[] {
  return [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
    join(home, ".config", "fish", "config.fish"),
  ];
}

/**
 * Directories that hold more than just this program. `install.sh`
 * defaults to `~/.local/bin`, which on a real machine also holds
 * unrelated binaries — deleting it wholesale would take out the
 * operator's other tools. So the plan removes the files it installed *by
 * name* and never the directory itself. `install.ps1` is the opposite
 * case: it defaults to `%LOCALAPPDATA%\atomic-agent`, a directory that
 * exists solely for this program, so there removing the tree is correct.
 *
 * When in doubt this returns `true`: leaving a stray empty directory is a
 * harmless outcome, and deleting someone's `~/bin` is not.
 */
export function isSharedInstallDir(
  dir: string,
  home: string = homedir(),
): boolean {
  const normalized = resolve(dir).replace(/[\\/]+$/, "");
  const leaf = basename(normalized).toLowerCase();
  // A directory named after the product is ours to remove.
  if (leaf === "atomic-agent") return false;
  // Anything else — ~/.local/bin, /usr/local/bin, ~/bin — is shared.
  void home;
  return true;
}

/** One filesystem removal the plan intends to perform. */
export interface UninstallTarget {
  readonly scope: UninstallScope;
  readonly path: string;
  readonly kind: "file" | "directory";
  /** Shown in the preview so the operator knows what each line is. */
  readonly label: string;
}

/** An edit to a shell rc file: drop the marker line and the line after it. */
export interface UninstallPathEdit {
  readonly scope: "path";
  readonly file: string;
  readonly marker: string;
}

export interface UninstallPlan {
  readonly scopes: readonly UninstallScope[];
  readonly targets: readonly UninstallTarget[];
  readonly pathEdits: readonly UninstallPathEdit[];
  /**
   * Install directory that was inspected but deliberately left in place
   * because other programs live there. Surfaced so the preview can say
   * so rather than leaving the operator wondering.
   */
  readonly preservedInstallDir?: string;
  /** Human-readable notes rendered under the preview. */
  readonly notes: readonly string[];
}

export interface BuildUninstallPlanParams {
  readonly scopes: readonly UninstallScope[];
  /** Directory holding the installed binary (usually `dirname(execPath)`). */
  readonly installDir: string;
  /** Resolved state directory (`config.paths.stateDir`). */
  readonly stateDir: string;
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  /** Injected for tests; defaults to a real `existsSync`. */
  readonly exists: (path: string) => boolean;
  /** Reads a shell rc file, or returns null when unreadable. */
  readonly readFile: (path: string) => string | null;
}

/**
 * Build the removal plan without touching the disk. Everything the
 * command does — preview, confirmation text, and the removal itself —
 * reads from this one structure, so `--dry-run` cannot drift from the
 * real run: they are the same plan, executed or not.
 */
export function buildUninstallPlan(
  params: BuildUninstallPlanParams,
): UninstallPlan {
  const {
    scopes,
    installDir,
    stateDir,
    home = homedir(),
    platform = process.platform,
    exists,
    readFile,
  } = params;

  const selected = new Set(scopes);
  const targets: UninstallTarget[] = [];
  const pathEdits: UninstallPathEdit[] = [];
  const notes: string[] = [];
  let preservedInstallDir: string | undefined;

  if (selected.has("app")) {
    const shared = isSharedInstallDir(installDir, home);

    for (const name of INSTALLED_BINARY_NAMES) {
      const candidate = join(installDir, name);
      if (exists(candidate)) {
        targets.push({
          scope: "app",
          path: candidate,
          kind: "file",
          label: "binary",
        });
      }
    }

    for (const name of INSTALLED_ASSET_DIRS) {
      const candidate = join(installDir, name);
      if (exists(candidate)) {
        targets.push({
          scope: "app",
          path: candidate,
          kind: "directory",
          label: "bundled assets",
        });
      }
    }

    if (shared) {
      preservedInstallDir = installDir;
      notes.push(
        `${installDir} is left in place — other programs live there. ` +
          "Only the files listed above are removed.",
      );
    }
  }

  if (selected.has("path")) {
    for (const rc of candidateShellRcFiles(home)) {
      const contents = readFile(rc);
      if (contents !== null && contents.includes(PATH_MARKER)) {
        pathEdits.push({ scope: "path", file: rc, marker: PATH_MARKER });
      }
    }
    if (platform === "win32") {
      notes.push(
        "On Windows the installer edits the user PATH in the registry. " +
          "Remove the entry from Settings > Environment Variables, or run: " +
          "[Environment]::SetEnvironmentVariable('Path', " +
          "(([Environment]::GetEnvironmentVariable('Path','User')" +
          ").Split(';') | Where-Object { $_ -ne '" +
          installDir +
          "' }) -join ';', 'User')",
      );
    }
  }

  if (selected.has("state")) {
    if (exists(stateDir)) {
      targets.push({
        scope: "state",
        path: stateDir,
        kind: "directory",
        label: "config, sessions, memory, secrets, downloaded models",
      });
    }
    notes.push(
      "The state directory holds your API keys in plaintext and every " +
        "session transcript. Removing it is not reversible.",
    );
  } else {
    notes.push(
      `State kept at ${stateDir} — reinstalling restores your sessions, ` +
        "memory and config. Pass --state (or --all) to erase it.",
    );
  }

  return {
    scopes: [...selected].sort(
      (a, b) => UNINSTALL_SCOPES.indexOf(a) - UNINSTALL_SCOPES.indexOf(b),
    ),
    targets,
    pathEdits,
    preservedInstallDir,
    notes,
  };
}

/** True when the plan would not touch anything. */
export function isEmptyPlan(plan: UninstallPlan): boolean {
  return plan.targets.length === 0 && plan.pathEdits.length === 0;
}

/**
 * Strip the installer's PATH block from an rc file: the marker comment
 * and the single line that follows it, plus the blank line the installer
 * wrote before the marker. Returns the file unchanged when the marker is
 * absent, so running it twice is safe.
 */
export function stripPathBlock(contents: string, marker: string): string {
  const lines = contents.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() === marker) {
      // Drop the marker and the export line under it.
      i += 1;
      // Also drop the blank separator the installer appended before it.
      while (out.length > 0 && out[out.length - 1]?.trim() === "") {
        out.pop();
      }
      continue;
    }
    out.push(lines[i] ?? "");
  }
  const result = out.join("\n");
  // Keep exactly one trailing newline when the original had one.
  if (contents.endsWith("\n") && !result.endsWith("\n")) return `${result}\n`;
  return result;
}

/** Render the plan as the preview shown by `--dry-run` and the confirm. */
export function formatUninstallPlan(plan: UninstallPlan): string {
  const lines: string[] = [];

  if (isEmptyPlan(plan)) {
    lines.push("Nothing to remove — no installed files matched.");
    for (const note of plan.notes) lines.push(`  note: ${note}`);
    return lines.join("\n");
  }

  lines.push(`Scopes: ${plan.scopes.join(", ")}`);
  lines.push("");
  lines.push("Would remove:");
  for (const target of plan.targets) {
    const suffix = target.kind === "directory" ? "/" : "";
    lines.push(`  ${target.path}${suffix}   (${target.label})`);
  }
  for (const edit of plan.pathEdits) {
    lines.push(`  ${edit.file}   (PATH line added by the installer)`);
  }
  if (plan.notes.length > 0) {
    lines.push("");
    for (const note of plan.notes) lines.push(`  note: ${note}`);
  }
  return lines.join("\n");
}

/** Resolve the install directory from the running binary. */
export function installDirFromExecPath(execPath: string): string {
  return dirname(execPath);
}
