import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveServeApiKey,
  serveApiKeyNotice,
  serveApiKeyPath,
  type ServeApiKey,
} from "./serve-api-key.js";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "serve-api-key-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function resolved(given: string | null): ServeApiKey {
  const key = resolveServeApiKey(given, stateDir);
  if ("error" in key) throw new Error(key.error);
  return key;
}

describe("resolveServeApiKey", () => {
  it("uses a given key as is and writes no file", () => {
    expect(resolved("operator-key-0123456789")).toEqual({ key: "operator-key-0123456789", source: "given" });
    expect(() => statSync(serveApiKeyPath(stateDir))).toThrow();
  });

  it("generates a key on the first run, owner-only, and reuses it after", () => {
    const first = resolved(null);
    expect(first.source).toBe("file");
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    if (first.source !== "file") throw new Error("unreachable");
    expect(first.created).toBe(true);
    expect(first.path).toBe(join(stateDir, "serve-api.key"));
    if (process.platform !== "win32") {
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    }
    const second = resolved(null);
    expect(second.key).toBe(first.key);
    expect(second.source === "file" && second.created).toBe(false);
  });

  it("keeps a key the user wrote into the file", () => {
    writeFileSync(serveApiKeyPath(stateDir), "my-own-serve-key-0123\n", { mode: 0o600 });
    expect(resolved(null).key).toBe("my-own-serve-key-0123");
  });

  it("replaces a file that holds no usable key", () => {
    writeFileSync(serveApiKeyPath(stateDir), "  \n", { mode: 0o600 });
    expect(resolved(null).key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses, rather than running keyless, when the file cannot be created", () => {
    // A state "dir" that is a file: nothing can be written under it.
    const notADir = join(stateDir, "plain-file");
    writeFileSync(notADir, "x");
    const key = resolveServeApiKey(null, notADir);
    expect("error" in key && key.error).toContain("--api-key");
  });
});

describe("serveApiKeyNotice", () => {
  const fileKey: ServeApiKey = { key: "abc123", source: "file", path: "/s/serve-api.key", created: true };

  it("says nothing about a key the operator gave", () => {
    expect(serveApiKeyNotice({ key: "k", source: "given" }, "http://127.0.0.1:8787", true)).toBe("");
  });

  it("says where the generated key is and how to print it, without the key itself", () => {
    const notice = serveApiKeyNotice(fileKey, "http://127.0.0.1:8787", false);
    expect(notice).toContain("/s/serve-api.key");
    expect(notice).toContain("generated");
    expect(notice).toContain("--print-api-key");
    expect(notice).not.toContain("abc123");
  });

  it("in a terminal, adds the panel address with the key in its fragment", () => {
    const notice = serveApiKeyNotice(fileKey, "http://127.0.0.1:8787", true);
    expect(notice).toContain("http://127.0.0.1:8787/panel#key=abc123");
  });
});
