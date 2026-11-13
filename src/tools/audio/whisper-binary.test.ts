import { describe, expect, it } from "vitest";
import { findExecutable, resolveFfmpegBinary, resolveWhisperBinary, WHISPER_BIN_ENV } from "./whisper-binary.js";

const noWiden = (env: NodeJS.ProcessEnv) => env;
const only = (...paths: string[]) => (path: string) => paths.includes(path);

describe("whisper.cpp binary lookup (ATO-702)", () => {
  it("finds whisper-cli on PATH before the older whisper-cpp name", () => {
    const r = resolveWhisperBinary({
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      platform: "darwin",
      widenEnv: noWiden,
      isExecutable: only("/opt/homebrew/bin/whisper-cli", "/usr/bin/whisper-cpp"),
    });
    expect(r).toEqual({ found: true, path: "/opt/homebrew/bin/whisper-cli", source: "path" });
  });

  it("falls back to whisper-cpp and never takes the Python `whisper`", () => {
    expect(resolveWhisperBinary({
      env: { PATH: "/usr/local/bin" }, platform: "linux", widenEnv: noWiden,
      isExecutable: only("/usr/local/bin/whisper-cpp"),
    })).toMatchObject({ found: true, path: "/usr/local/bin/whisper-cpp" });
    expect(resolveWhisperBinary({
      env: { PATH: "/usr/local/bin" }, platform: "linux", widenEnv: noWiden,
      isExecutable: only("/usr/local/bin/whisper"),
    }).found).toBe(false);
  });

  it("takes the downloaded copy before PATH, after the configured path", () => {
    const managed = "/state/models/whisper/bin/b5454/whisper-cli";
    const base = { env: { PATH: "/usr/bin" }, platform: "linux" as const, widenEnv: noWiden };
    expect(resolveWhisperBinary({ ...base, isExecutable: only(managed, "/usr/bin/whisper-cli") }, managed))
      .toEqual({ found: true, path: managed, source: "managed" });
    expect(resolveWhisperBinary({ ...base, isExecutable: only("/usr/bin/whisper-cli") }, managed))
      .toEqual({ found: true, path: "/usr/bin/whisper-cli", source: "path" });
    expect(resolveWhisperBinary({ ...base, env: { ...base.env, [WHISPER_BIN_ENV]: "/opt/w/whisper-cli" }, isExecutable: only(managed, "/opt/w/whisper-cli") }, managed))
      .toMatchObject({ source: "env" });
  });

  it("prefers the configured path and refuses a relative or missing one", () => {
    expect(resolveWhisperBinary({
      env: { [WHISPER_BIN_ENV]: "/opt/w/whisper-cli", PATH: "/usr/bin" }, platform: "darwin", widenEnv: noWiden,
      isExecutable: only("/opt/w/whisper-cli", "/usr/bin/whisper-cli"),
    })).toEqual({ found: true, path: "/opt/w/whisper-cli", source: "env" });
    const relative = resolveWhisperBinary({ env: { [WHISPER_BIN_ENV]: "bin/whisper-cli" }, platform: "darwin", widenEnv: noWiden, isExecutable: () => true });
    expect(relative).toMatchObject({ found: false });
    const missing = resolveWhisperBinary({ env: { [WHISPER_BIN_ENV]: "/nope/whisper-cli" }, platform: "darwin", widenEnv: noWiden, isExecutable: () => false });
    expect(missing.found ? "" : missing.reason).toContain("/nope/whisper-cli");
  });

  it("says how to install it, per platform", () => {
    const mac = resolveWhisperBinary({ env: { PATH: "" }, platform: "darwin", widenEnv: noWiden, isExecutable: () => false });
    expect(mac.found ? "" : mac.reason).toContain("brew install whisper-cpp");
    const win = resolveWhisperBinary({ env: { PATH: "" }, platform: "win32", widenEnv: noWiden, isExecutable: () => false });
    expect(win.found ? "" : win.reason).toContain("whisper-bin-x64.zip");
    const ff = resolveFfmpegBinary({ env: { PATH: "" }, platform: "linux", widenEnv: noWiden, isExecutable: () => false });
    expect(ff.found ? "" : ff.reason).toContain("apt install ffmpeg");
  });

  it("tries PATHEXT on Windows", () => {
    const path = findExecutable(["whisper-cli"], {
      env: { PATH: "C:\\tools;C:\\whisper", PATHEXT: ".COM;.EXE" },
      platform: "win32",
      widenEnv: noWiden,
      isExecutable: (p) => p.endsWith("whisper-cli.EXE") && p.includes("whisper"),
    });
    expect(path).toMatch(/whisper-cli\.EXE$/);
  });

  it("searches the widened PATH a desktop-launched agent needs", () => {
    const r = resolveWhisperBinary({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      widenEnv: (env) => ({ ...env, PATH: `${env.PATH}:/opt/homebrew/bin` }),
      isExecutable: only("/opt/homebrew/bin/whisper-cli"),
    });
    expect(r).toMatchObject({ found: true, path: "/opt/homebrew/bin/whisper-cli" });
  });
});
