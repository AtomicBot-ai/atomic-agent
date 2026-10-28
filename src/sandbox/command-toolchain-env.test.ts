import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { buildCommandEnv } from "./command-env.js";
import {
  NON_INTERACTIVE_ENV,
  nvmDefaultBin,
  withToolchainEnv,
} from "./command-toolchain-env.js";

describe("withToolchainEnv (ATO-1252)", () => {
  it("fills the non-interactive switches, keeping a value the user set", () => {
    const env = withToolchainEnv(
      { PATH: "/usr/bin", HOMEBREW_NO_AUTO_UPDATE: "0" },
      { platform: "darwin", home: "/nohome", exists: () => false, systemPaths: [] },
    );
    expect(env.HOMEBREW_NO_AUTO_UPDATE).toBe("0");
    expect(env.DEBIAN_FRONTEND).toBe("noninteractive");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.CI).toBeUndefined();
  });

  it("appends Homebrew on Apple Silicon after the inherited PATH, never before it", () => {
    const env = withToolchainEnv(
      { PATH: "/usr/bin:/bin" },
      { platform: "darwin", home: "/Users/u", systemPaths: [], exists: (p) => p === "/opt/homebrew/bin" || p === "/Users/u/.pyenv/shims" },
    );
    expect(env.PATH).toBe("/usr/bin:/bin:/opt/homebrew/bin:/Users/u/.pyenv/shims");
  });

  it("adds the macOS system PATH list and does not repeat one already there", () => {
    const env = withToolchainEnv(
      { PATH: "/usr/bin:/opt/homebrew/bin" },
      { platform: "darwin", home: "/Users/u", exists: (p) => p !== "/missing", systemPaths: ["/opt/homebrew/bin", "/Library/TeX/texbin", "/missing", "relative/dir"] },
    );
    expect(env.PATH?.split(":").slice(0, 3)).toEqual(["/usr/bin", "/opt/homebrew/bin", "/Library/TeX/texbin"]);
    expect(env.PATH).not.toContain("/missing");
    expect(env.PATH).not.toContain("relative/dir");
  });

  it("adds no secret back: a key the filter removed stays removed", () => {
    const filtered = buildCommandEnv({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-x", HOME: "/h" });
    const env = withToolchainEnv(filtered, { platform: "linux", exists: () => false });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "PATH", ...Object.keys(NON_INTERACTIVE_ENV)].sort(),
    );
  });

  it("leaves Windows PATH alone", () => {
    const env = withToolchainEnv({ PATH: "C:\\Windows" }, { platform: "win32", exists: () => true });
    expect(env.PATH).toBe("C:\\Windows");
  });
});

describe("nvmDefaultBin", () => {
  it("picks the version the default alias names, else the newest", () => {
    const nvm = mkdtempSync(join(tmpdir(), "atomic-nvm-"));
    for (const v of ["v18.19.0", "v20.11.1", "v20.9.0", "v22.1.0"]) {
      mkdirSync(join(nvm, "versions", "node", v, "bin"), { recursive: true });
    }
    expect(nvmDefaultBin(nvm)).toBe(join(nvm, "versions", "node", "v22.1.0", "bin"));
    mkdirSync(join(nvm, "alias"));
    writeFileSync(join(nvm, "alias", "default"), "20\n");
    expect(nvmDefaultBin(nvm)).toBe(join(nvm, "versions", "node", "v20.11.1", "bin"));
    writeFileSync(join(nvm, "alias", "default"), "lts/iron\n");
    expect(nvmDefaultBin(nvm)).toBe(join(nvm, "versions", "node", "v22.1.0", "bin"));
  });

  it("is null without nvm", () => {
    expect(nvmDefaultBin(join(tmpdir(), "no-such-nvm-dir"))).toBeNull();
  });
});
