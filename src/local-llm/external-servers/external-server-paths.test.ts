import { describe, expect, it } from "vitest";

import {
  findOnPath,
  lmsBinaryCandidates,
  lmstudioModelsDirs,
  ollamaAppCandidates,
  ollamaBinaryCandidates,
  ollamaModelsDirs,
  type HostPaths,
} from "./external-server-paths.js";

const mac: HostPaths = { platform: "darwin", home: "/Users/me", env: { PATH: "/usr/bin:/opt/homebrew/bin" } };
const win: HostPaths = {
  platform: "win32",
  home: "C:\\Users\\me",
  env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me", Path: "C:\\Windows;C:\\Tools" },
};
const linux: HostPaths = { platform: "linux", home: "/home/me", env: { PATH: "/usr/bin" } };

describe("where Ollama and LM Studio live (ATO-2490)", () => {
  it("Ollama's CLI on each platform", () => {
    expect(ollamaBinaryCandidates(mac)[0]).toBe("/Applications/Ollama.app/Contents/Resources/ollama");
    expect(ollamaBinaryCandidates(win)).toEqual(["C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama.exe"]);
    expect(ollamaBinaryCandidates(linux)).toContain("/usr/local/bin/ollama");
  });

  it("the Ollama app that keeps the server up: macOS and Windows only", () => {
    expect(ollamaAppCandidates(mac)).toContain("/Applications/Ollama.app");
    expect(ollamaAppCandidates(win)).toEqual(["C:\\Users\\me\\AppData\\Local\\Programs\\Ollama\\ollama app.exe"]);
    expect(ollamaAppCandidates(linux)).toEqual([]);
  });

  it("OLLAMA_MODELS wins; the Linux service folder is tried too", () => {
    expect(ollamaModelsDirs({ ...mac, env: { OLLAMA_MODELS: "/Volumes/Ext/ollama" } })[0]).toBe("/Volumes/Ext/ollama");
    expect(ollamaModelsDirs(win)).toEqual(["C:\\Users\\me\\.ollama\\models"]);
    expect(ollamaModelsDirs(linux)).toEqual(["/home/me/.ollama/models", "/usr/share/ollama/.ollama/models"]);
  });

  it("lms: ~/.lmstudio/bin, lms.exe under the profile on Windows", () => {
    expect(lmsBinaryCandidates(mac)[0]).toBe("/Users/me/.lmstudio/bin/lms");
    expect(lmsBinaryCandidates(win)[0]).toBe("C:\\Users\\me\\.lmstudio\\bin\\lms.exe");
    expect(lmstudioModelsDirs(mac, "/Volumes/Models")[0]).toBe("/Volumes/Models");
    expect(lmstudioModelsDirs(linux, null)).toEqual(["/home/me/.lmstudio/models", "/home/me/.cache/lm-studio/models"]);
  });

  it("PATH lookup adds .exe on Windows and splits on ;", () => {
    const seen = new Set(["C:\\Tools\\ollama.exe", "/opt/homebrew/bin/ollama"]);
    expect(findOnPath("ollama", win, (p) => seen.has(p))).toBe("C:\\Tools\\ollama.exe");
    expect(findOnPath("ollama", mac, (p) => seen.has(p))).toBe("/opt/homebrew/bin/ollama");
    expect(findOnPath("ollama", linux, (p) => seen.has(p))).toBeNull();
  });
});
