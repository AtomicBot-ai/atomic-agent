import {
  existsSync,
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
} from "./shared-install-id.js";

const LOCAL = "11111111-2222-4333-8444-555555555555";
const SHARED = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

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

  it("resolves the default path under the home dir", () => {
    expect(resolveSharedInstallIdPath({}, "/h")).toBe(
      join("/h", ".atomic-agent-install-id"),
    );
    expect(
      resolveSharedInstallIdPath({ ATOMIC_AGENT_INSTALL_ID_FILE: "/x/id" }, "/h"),
    ).toBe("/x/id");
  });
});
