import { platform } from "node:os";
import { compressToolResult } from "../../compressor/result-compressor.js";
import type { ToolDefinition } from "../tool-registry.js";
import { runCommand } from "../../sandbox/command-runner.js";

/**
 * Minimal cross-platform window management via shell utilities. We do not
 * ship a native addon; instead we shell out to the user-space tool that is
 * most idiomatic for the host OS. Failure modes are explicit and
 * human-readable so the LLM can decide whether to fall back gracefully.
 */

export const osWindowListTool: ToolDefinition = {
  name: "os.window.list",
  description:
    "List visible window titles. On Linux requires `wmctrl`; macOS uses osascript; Windows uses PowerShell.",
  readonly: true,
  async run(_rawArgs, ctx) {
    const os = platform();
    const script = listScript(os);
    if (!script) {
      throw new Error(
        `os.window.list: unsupported platform ${os}`,
      );
    }
    const result = await runCommand(script.cmd, script.args, {
      cwd: ctx.workingDir,
      signal: ctx.signal,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      return compressToolResult({
        tool: "os.window.list",
        status: "error",
        output: result.stderr || "window list failed",
        details: { platform: os, stderr: result.stderr },
      });
    }
    return compressToolResult({
      tool: "os.window.list",
      status: "ok",
      output: result.stdout.trim(),
      details: { platform: os, lines: result.stdout.split("\n").length },
    });
  },
};

export const osWindowFocusTool: ToolDefinition = {
  name: "os.window.focus",
  description:
    "Bring a window to the foreground by matching its title (substring).",
  readonly: false,
  async run(rawArgs, ctx) {
    const title = rawArgs.title;
    if (typeof title !== "string" || title.length === 0) {
      throw new Error("os.window.focus: `title` must be a non-empty string");
    }
    const os = platform();
    const script = focusScript(os, title);
    if (!script) {
      throw new Error(`os.window.focus: unsupported platform ${os}`);
    }
    const result = await runCommand(script.cmd, script.args, {
      cwd: ctx.workingDir,
      signal: ctx.signal,
      timeoutMs: 10_000,
    });
    const status = result.exitCode === 0 ? "ok" : "error";
    return compressToolResult({
      tool: "os.window.focus",
      status,
      output:
        status === "ok"
          ? `focused window matching "${title}"`
          : result.stderr || "window focus failed",
      details: { platform: os, title, exitCode: result.exitCode },
    });
  },
};

function listScript(os: NodeJS.Platform):
  | { cmd: string; args: string[] }
  | null {
  switch (os) {
    case "darwin":
      return {
        cmd: "osascript",
        args: [
          "-e",
          'tell application "System Events" to get {name, (every window whose visible is true)} of every process whose background only is false',
        ],
      };
    case "linux":
      return { cmd: "wmctrl", args: ["-l"] };
    case "win32":
      return {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, MainWindowTitle | Format-Table -AutoSize | Out-String",
        ],
      };
    default:
      return null;
  }
}

function focusScript(
  os: NodeJS.Platform,
  title: string,
): { cmd: string; args: string[] } | null {
  switch (os) {
    case "darwin":
      return {
        cmd: "osascript",
        args: [
          "-e",
          `tell application "System Events" to tell (first process whose frontmost is false and (name contains "${escapeAppleScript(title)}")) to set frontmost to true`,
        ],
      };
    case "linux":
      return { cmd: "wmctrl", args: ["-a", title] };
    case "win32":
      return {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-Command",
          `(Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapePowerShell(title)}*' } | Select-Object -First 1).MainWindowHandle | ForEach-Object { [void][Microsoft.VisualBasic.Interaction]::AppActivate((Get-Process -Id $_).Id) }`,
        ],
      };
    default:
      return null;
  }
}

function escapeAppleScript(input: string): string {
  return input.replace(/"/g, '\\"');
}

function escapePowerShell(input: string): string {
  return input.replace(/'/g, "''");
}
