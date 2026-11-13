import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleSecrets } from "./config-secrets-command.js";

/**
 * Only the read-only paths: `keychain` / `env` go through the real OS
 * keychain binding and are covered with a fake one in
 * src/config/secrets-migration.test.ts.
 */
describe("config secrets", () => {
  let stateDir: string;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "config-secrets-"));
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("reports .env as the default store", () => {
    expect(handleSecrets([], stateDir)).toBe(0);
    expect(out.join("")).toBe("Secrets store: .env\n");
  });

  it("lists key names held in the keychain", () => {
    writeFileSync(
      join(stateDir, "secrets-store.json"),
      JSON.stringify({ store: "keychain", keychainKeys: ["OPENAI_API_KEY"] }),
    );
    expect(handleSecrets(["status"], stateDir)).toBe(0);
    expect(out.join("")).toBe(
      "Secrets store: OS keychain\nKeys in the OS keychain: OPENAI_API_KEY\n",
    );
  });

  it("rejects an unknown subcommand", () => {
    expect(handleSecrets(["vault"], stateDir)).toBe(1);
    expect(err.join("")).toContain("unknown secrets subcommand: vault");
  });
});
