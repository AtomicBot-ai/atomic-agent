import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  INSTALLER_PATH_MARKER,
  stripInstallerPathLine,
} from "./strip-installer-path-line.js";

describe("stripInstallerPathLine", () => {
  it("removes the marker, the PATH line and the blank line above them", () => {
    const rc = [
      "export EDITOR=vim",
      "",
      INSTALLER_PATH_MARKER,
      'export PATH="$HOME/.local/bin:$PATH"',
      "",
    ].join("\n");
    const result = stripInstallerPathLine(rc);
    expect(result.changed).toBe(true);
    expect(result.content).toBe("export EDITOR=vim\n");
  });

  it("removes the fish form too", () => {
    const rc = [
      INSTALLER_PATH_MARKER,
      "set -gx PATH $HOME/.local/bin $PATH",
      "alias ll='ls -la'",
    ].join("\n");
    expect(stripInstallerPathLine(rc).content).toBe("alias ll='ls -la'");
  });

  it("leaves an rc file the installer never touched alone", () => {
    const rc = 'export PATH="$HOME/.local/bin:$PATH"\n';
    const result = stripInstallerPathLine(rc);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(rc);
  });

  it("keeps a deliberate separator that is not the installer's own", () => {
    const rc = ["a=1", "", "", INSTALLER_PATH_MARKER, "export PATH=x", "b=2"].join("\n");
    // One blank line goes with the stanza; the other was the operator's.
    expect(stripInstallerPathLine(rc).content).toBe("a=1\n\nb=2");
  });

  it("removes every copy when the installer ran more than once", () => {
    const rc = [
      INSTALLER_PATH_MARKER,
      "export PATH=x",
      INSTALLER_PATH_MARKER,
      "export PATH=x",
      "done=1",
    ].join("\n");
    expect(stripInstallerPathLine(rc).content).toBe("done=1");
  });

  it("matches the marker install.sh actually writes", () => {
    // The two strings live in different languages and cannot be shared;
    // this is the assertion that keeps them one string.
    const here = dirname(fileURLToPath(import.meta.url));
    const installSh = readFileSync(
      resolve(here, "..", "..", "scripts", "install.sh"),
      "utf8",
    );
    expect(installSh).toContain(INSTALLER_PATH_MARKER);
  });
});
