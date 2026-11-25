import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

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

  it("status --json carries the store and the names only", () => {
    writeFileSync(
      join(stateDir, "secrets-store.json"),
      JSON.stringify({ store: "keychain", keychainKeys: ["OPENAI_API_KEY"] }),
    );
    expect(handleSecrets(["status", "--json"], stateDir)).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      store: "keychain",
      keychainKeys: ["OPENAI_API_KEY"],
    });
  });

  // ATO-1639: one key at a time, for the desktop app. Default (.env) mode
  // only here; the keychain branch is src/config/secret-access.test.ts.
  it("set reads the value from stdin and says where it went", async () => {
    const code = await handleSecrets(
      ["set", "OPENROUTER_API_KEY", "--json"],
      stateDir,
      Readable.from(["sk-or-1\n"]),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({ name: "OPENROUTER_API_KEY", store: "env" });
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("OPENROUTER_API_KEY=sk-or-1\n");
    expect(out.join("")).not.toContain("sk-or-1");
  });

  it("set refuses a name that is not a key, and an empty value", async () => {
    expect(await handleSecrets(["set", "NODE_OPTIONS"], stateDir, Readable.from(["x"]))).toBe(1);
    expect(await handleSecrets(["set", "OPENAI_API_KEY"], stateDir, Readable.from([""]))).toBe(1);
    expect(await handleSecrets(["set"], stateDir, Readable.from(["x"]))).toBe(1);
    expect(err.join("")).toContain("usage: atomic-agent config secrets set <NAME>");
  });

  it("get prints a saved value; exit 1 when nothing is saved", async () => {
    expect(handleSecrets(["get", "GEMINI_API_KEY"], stateDir)).toBe(1);
    expect(err.join("")).toContain("GEMINI_API_KEY is not saved");
    writeFileSync(join(stateDir, ".env"), "GEMINI_API_KEY=g-1\n");
    expect(handleSecrets(["get", "GEMINI_API_KEY"], stateDir)).toBe(0);
    expect(out.join("")).toBe("g-1\n");
  });

  it("unset removes the key", () => {
    writeFileSync(join(stateDir, ".env"), "GEMINI_API_KEY=g-1\nATOMIC_PORT=1\n");
    expect(handleSecrets(["unset", "GEMINI_API_KEY"], stateDir)).toBe(0);
    expect(readFileSync(join(stateDir, ".env"), "utf8")).toBe("ATOMIC_PORT=1\n");
  });

  it("rejects an unknown subcommand", () => {
    expect(handleSecrets(["vault"], stateDir)).toBe(1);
    expect(err.join("")).toContain("unknown secrets subcommand: vault");
  });
});
