import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isValidInstallId,
  resolveSharedInstallId,
  resolveSharedInstallIdPath,
} from "./resolve-shared-install-id.js";

const LOCAL = "11111111-2222-4333-8444-555555555555";
const SHARED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const TERMINAL = "99999999-8888-4777-8666-555555555555";

describe("resolveSharedInstallId", () => {
  let dir: string;
  let file: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-shared-id-"));
    file = join(dir, "install-id");
    env = { VITEST: "1", ATOMIC_AGENT_INSTALL_ID_FILE: file };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses a valid id already in the shared file", () => {
    writeFileSync(file, `${SHARED}\n`, "utf8");
    expect(resolveSharedInstallId({ localId: LOCAL, enabled: true, env })).toBe(
      SHARED,
    );
  });

  it("migrates the local id into a missing shared file", () => {
    expect(resolveSharedInstallId({ localId: LOCAL, enabled: true, env })).toBe(
      LOCAL,
    );
    expect(readFileSync(file, "utf8").trim()).toBe(LOCAL);
  });

  it("replaces a corrupt shared file with the local id", () => {
    writeFileSync(file, "not-a-uuid\n", "utf8");
    expect(resolveSharedInstallId({ localId: LOCAL, enabled: true, env })).toBe(
      LOCAL,
    );
    expect(readFileSync(file, "utf8").trim()).toBe(LOCAL);
  });

  it("mints a fresh UUID when there is no valid local id either", () => {
    const id = resolveSharedInstallId({ localId: "", enabled: true, env });
    expect(isValidInstallId(id)).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe(id);
  });

  it("does not touch the shared file while analytics is disabled", () => {
    expect(
      resolveSharedInstallId({ localId: LOCAL, enabled: false, env }),
    ).toBe(LOCAL);
    expect(existsSync(file)).toBe(false);
  });

  it("never writes the default home path under the test runner", () => {
    const home = join(dir, "home");
    const id = resolveSharedInstallId({
      localId: LOCAL,
      enabled: true,
      env: { VITEST: "1" },
      home,
    });
    expect(id).toBe(LOCAL);
    expect(existsSync(join(home, ".atomic-agent-install-id"))).toBe(false);
  });

  it("falls back to the local id when the shared file cannot be written", () => {
    // The parent "directory" is a regular file, so mkdir fails.
    writeFileSync(join(dir, "placeholder"), "");
    const id = resolveSharedInstallId({
      localId: LOCAL,
      enabled: true,
      env: {
        VITEST: "1",
        ATOMIC_AGENT_INSTALL_ID_FILE: join(dir, "placeholder", "x"),
      },
    });
    expect(id).toBe(LOCAL);
  });

  it("returns the local id under ATOMIC_AGENT_ANALYTICS=off without writing", () => {
    const id = resolveSharedInstallId({
      localId: LOCAL,
      enabled: true,
      env: { ...env, ATOMIC_AGENT_ANALYTICS: "off" },
    });
    expect(id).toBe(LOCAL);
    expect(existsSync(file)).toBe(false);
  });

  it("returns an invalid local id as-is while disabled (no UUID minted)", () => {
    expect(resolveSharedInstallId({ localId: "", enabled: false, env })).toBe(
      "",
    );
    expect(existsSync(file)).toBe(false);
  });

  it("resolves the default path under the home dir", () => {
    expect(resolveSharedInstallIdPath({}, "/h")).toBe(
      join("/h", ".atomic-agent-install-id"),
    );
    expect(
      resolveSharedInstallIdPath({ ATOMIC_AGENT_INSTALL_ID_FILE: "/x/id" }, "/h"),
    ).toBe("/x/id");
  });
});

describe("resolveSharedInstallId — desktop adopts the terminal id", () => {
  let dir: string;
  let file: string;
  let terminalStateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-shared-id-term-"));
    file = join(dir, "install-id");
    terminalStateDir = join(dir, "terminal-state");
    mkdirSync(terminalStateDir, { recursive: true });
    env = { VITEST: "1", ATOMIC_AGENT_INSTALL_ID_FILE: file };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTerminal(files: { analytics?: unknown; config?: unknown }) {
    if (files.analytics !== undefined) {
      writeFileSync(
        join(terminalStateDir, "analytics.json"),
        JSON.stringify(files.analytics),
      );
    }
    if (files.config !== undefined) {
      writeFileSync(
        join(terminalStateDir, "config.json"),
        JSON.stringify(files.config),
      );
    }
  }

  function resolveAs(surface: "desktop" | "tui"): string {
    return resolveSharedInstallId({
      localId: LOCAL,
      enabled: true,
      surface,
      env,
      terminalStateDir,
    });
  }

  it("keeps an existing shared id over the terminal id", () => {
    writeFileSync(file, `${SHARED}\n`);
    writeTerminal({ analytics: { installId: TERMINAL } });
    expect(resolveAs("desktop")).toBe(SHARED);
  });

  it("adopts the terminal id when the shared file is missing", () => {
    writeTerminal({ analytics: { installId: TERMINAL } });
    expect(resolveAs("desktop")).toBe(TERMINAL);
    expect(readFileSync(file, "utf8").trim()).toBe(TERMINAL);
  });

  it("adopts it when the terminal config leaves analytics at its default", () => {
    writeTerminal({
      analytics: { installId: TERMINAL },
      config: { version: 1 },
    });
    expect(resolveAs("desktop")).toBe(TERMINAL);
  });

  it("does not link a terminal that opted out; uses the desktop's own id", () => {
    writeTerminal({
      analytics: { installId: TERMINAL },
      config: { analytics: { enabled: false } },
    });
    expect(resolveAs("desktop")).toBe(LOCAL);
    expect(readFileSync(file, "utf8").trim()).toBe(LOCAL);
  });

  it("falls back to the own id when the terminal never ran", () => {
    expect(resolveAs("desktop")).toBe(LOCAL);
  });

  it("ignores an invalid terminal id", () => {
    writeTerminal({ analytics: { installId: "nope" } });
    expect(resolveAs("desktop")).toBe(LOCAL);
  });

  it("only the desktop surface looks at the terminal dir", () => {
    writeTerminal({ analytics: { installId: TERMINAL } });
    expect(resolveAs("tui")).toBe(LOCAL);
  });

  it("mints only when neither the terminal nor the own id is usable", () => {
    const id = resolveSharedInstallId({
      localId: "",
      enabled: true,
      surface: "desktop",
      env,
      terminalStateDir,
    });
    expect(isValidInstallId(id)).toBe(true);
    expect(id).not.toBe(TERMINAL);
    expect(readFileSync(file, "utf8").trim()).toBe(id);
  });
});
