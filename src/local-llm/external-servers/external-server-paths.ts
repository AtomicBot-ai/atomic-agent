/**
 * Where Ollama and LM Studio keep their programs and their models on each
 * platform (ATO-2490). Pure: the caller passes the platform, the home
 * folder and the environment, and an `exists` check, so every branch is
 * testable on any machine.
 *
 * Sources, as each app documents or installs them:
 * - Ollama: macOS app `/Applications/Ollama.app` (CLI inside
 *   `Contents/Resources/ollama`, Homebrew `/opt/homebrew/bin` or
 *   `/usr/local/bin`); Windows `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`
 *   and its tray app `ollama app.exe`; Linux `/usr/local/bin/ollama` (the
 *   install script), `/usr/bin/ollama` (packages). Models in
 *   `$OLLAMA_MODELS`, else `~/.ollama/models`; the Linux service install
 *   keeps them under `/usr/share/ollama/.ollama/models`.
 * - LM Studio: the `lms` CLI in `~/.lmstudio/bin` (older builds
 *   `~/.cache/lm-studio/bin`), `lms.exe` on Windows; models in
 *   `~/.lmstudio/models` (older `~/.cache/lm-studio/models`) unless its
 *   settings name another `downloadsFolder`.
 */

import { homedir } from "node:os";
import { delimiter, join, posix, win32 } from "node:path";

export interface HostPaths {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  if (platform === "win32") return win32.join;
  return platform === process.platform ? join : posix.join;
}

/** `PATH` entries, split the platform's way. */
export function pathEntries(host: HostPaths): string[] {
  const raw = host.env.PATH ?? host.env.Path ?? "";
  const sep = host.platform === "win32" ? ";" : host.platform === process.platform ? delimiter : ":";
  return raw.split(sep).map((p) => p.trim()).filter(Boolean);
}

/** `name` on PATH (with `.exe` on Windows), first hit. */
export function findOnPath(
  name: string,
  host: HostPaths,
  exists: (path: string) => boolean,
): string | null {
  const j = joinFor(host.platform);
  const file = host.platform === "win32" && !/\.exe$/i.test(name) ? `${name}.exe` : name;
  for (const dir of pathEntries(host)) {
    const candidate = j(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function firstExisting(list: readonly string[], exists: (path: string) => boolean): string | null {
  for (const p of list) if (exists(p)) return p;
  return null;
}

/** The Ollama CLI, in the order it is looked for (PATH is tried after these by the caller). */
export function ollamaBinaryCandidates(host: HostPaths): string[] {
  const j = joinFor(host.platform);
  if (host.platform === "darwin") {
    return [
      "/Applications/Ollama.app/Contents/Resources/ollama",
      j(host.home, "Applications/Ollama.app/Contents/Resources/ollama"),
      "/opt/homebrew/bin/ollama",
      "/usr/local/bin/ollama",
    ];
  }
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA ?? j(host.home, "AppData", "Local");
    return [j(local, "Programs", "Ollama", "ollama.exe")];
  }
  return ["/usr/local/bin/ollama", "/usr/bin/ollama", j(host.home, ".local", "bin", "ollama")];
}

/**
 * The desktop app that starts Ollama's server and keeps it in the menu bar
 * or tray. Starting the app rather than a bare `ollama serve` is what a
 * person who installed the app expects: it stays up after we quit. Linux
 * has no app; `ollama serve` is the way there.
 */
export function ollamaAppCandidates(host: HostPaths): string[] {
  const j = joinFor(host.platform);
  if (host.platform === "darwin") {
    return ["/Applications/Ollama.app", j(host.home, "Applications/Ollama.app")];
  }
  if (host.platform === "win32") {
    const local = host.env.LOCALAPPDATA ?? j(host.home, "AppData", "Local");
    return [j(local, "Programs", "Ollama", "ollama app.exe")];
  }
  return [];
}

/** Folders that may hold Ollama's `manifests/` and `blobs/`, most likely first. */
export function ollamaModelsDirs(host: HostPaths): string[] {
  const j = joinFor(host.platform);
  const out: string[] = [];
  const custom = host.env.OLLAMA_MODELS?.trim();
  if (custom) out.push(custom);
  out.push(j(host.home, ".ollama", "models"));
  if (host.platform === "linux") out.push("/usr/share/ollama/.ollama/models");
  return out;
}

/** The `lms` CLI that LM Studio installs for its user. */
export function lmsBinaryCandidates(host: HostPaths): string[] {
  const j = joinFor(host.platform);
  const exe = host.platform === "win32" ? "lms.exe" : "lms";
  const home = host.platform === "win32" ? host.env.USERPROFILE ?? host.home : host.home;
  return [j(home, ".lmstudio", "bin", exe), j(home, ".cache", "lm-studio", "bin", exe)];
}

/** LM Studio's model folders: its own setting first, then the defaults. */
export function lmstudioModelsDirs(host: HostPaths, downloadsFolder?: string | null): string[] {
  const j = joinFor(host.platform);
  const home = host.platform === "win32" ? host.env.USERPROFILE ?? host.home : host.home;
  const out: string[] = [];
  if (downloadsFolder && downloadsFolder.trim()) out.push(downloadsFolder.trim());
  out.push(j(home, ".lmstudio", "models"), j(home, ".cache", "lm-studio", "models"));
  return out;
}

/** Where LM Studio's settings file is (it may name `downloadsFolder`). */
export function lmstudioSettingsFile(host: HostPaths): string {
  const j = joinFor(host.platform);
  const home = host.platform === "win32" ? host.env.USERPROFILE ?? host.home : host.home;
  return j(home, ".lmstudio", "settings.json");
}

/** The current machine, for callers that are not tests. */
export function currentHost(): HostPaths {
  return { platform: process.platform, home: homedir(), env: process.env };
}
