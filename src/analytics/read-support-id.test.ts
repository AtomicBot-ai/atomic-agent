import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSupportId } from "./read-support-id.js";

const SHARED = "11111111-2222-4333-8444-555555555555";
const LOCAL = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("readSupportId", () => {
  let dir: string;
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "support-id-"));
    home = join(dir, "home");
    stateDir = join(home, ".atomic-agent");
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the shared install id file", () => {
    writeFileSync(join(home, ".atomic-agent-install-id"), `${SHARED}\n`);
    writeFileSync(join(stateDir, "analytics.json"), JSON.stringify({ installId: LOCAL }));
    expect(readSupportId({ stateDir, env: {}, home })).toBe(SHARED);
  });

  it("honours the ATOMIC_AGENT_INSTALL_ID_FILE override", () => {
    const file = join(dir, "custom-id");
    writeFileSync(file, SHARED);
    expect(
      readSupportId({ stateDir, env: { ATOMIC_AGENT_INSTALL_ID_FILE: file }, home }),
    ).toBe(SHARED);
  });

  it("falls back to the state dir's own id", () => {
    writeFileSync(join(stateDir, "analytics.json"), JSON.stringify({ installId: LOCAL }));
    expect(readSupportId({ stateDir, env: {}, home })).toBe(LOCAL);
  });

  it("ignores a malformed shared file and a malformed analytics.json", () => {
    writeFileSync(join(home, ".atomic-agent-install-id"), "not-a-uuid");
    writeFileSync(join(stateDir, "analytics.json"), "{oops");
    expect(readSupportId({ stateDir, env: {}, home })).toBeNull();
  });

  it("returns null and writes nothing on a fresh machine", () => {
    expect(readSupportId({ stateDir, env: {}, home })).toBeNull();
    expect(existsSync(join(home, ".atomic-agent-install-id"))).toBe(false);
    expect(existsSync(join(stateDir, "analytics.json"))).toBe(false);
  });
});
