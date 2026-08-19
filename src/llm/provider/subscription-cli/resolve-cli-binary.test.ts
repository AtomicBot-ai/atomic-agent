import { describe, expect, it } from "vitest";

import { resolveCliBinary } from "./resolve-cli-binary.js";

describe("resolveCliBinary", () => {
  it("prefers a configured binPath on every platform", () => {
    expect(resolveCliBinary("claude", "/opt/bin/claude", "darwin")).toBe(
      "/opt/bin/claude",
    );
    expect(resolveCliBinary("claude", "C:\\bin\\claude.cmd", "win32")).toBe(
      "C:\\bin\\claude.cmd",
    );
  });

  it("hands the bare name to spawn on posix", () => {
    expect(resolveCliBinary("claude", undefined, "darwin")).toBe("claude");
    expect(resolveCliBinary("codex", undefined, "linux")).toBe("codex");
  });

  it("finds the .cmd shim on windows, where spawn with shell:false would not", () => {
    const present = new Set(["C:\\npm\\claude.cmd"]);
    expect(
      resolveCliBinary("claude", undefined, "win32", { PATH: "C:\\npm" }, (p) =>
        present.has(p),
      ),
    ).toBe("C:\\npm\\claude.cmd");
  });

  it("falls back to the bare name on windows so ENOENT still surfaces", () => {
    expect(
      resolveCliBinary("claude", undefined, "win32", { PATH: "C:\\npm" }, () => false),
    ).toBe("claude");
  });
});
