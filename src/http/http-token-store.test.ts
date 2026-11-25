import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addHttpToken,
  createHttpTokenSource,
  hashHttpToken,
  HTTP_TOKEN_PREFIX,
  httpTokensPath,
  readHttpTokens,
  removeHttpToken,
} from "./http-token-store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-http-tokens-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("http token store (ATO-583)", () => {
  it("a missing file is an empty list", () => {
    expect(readHttpTokens(dir)).toEqual({ ok: true, tokens: [] });
  });

  it("add returns the token once and stores only its hash, owner-only", () => {
    const added = addHttpToken(dir, "phone", "member", () => new Date("2026-11-18T10:00:00.000Z"));
    if (!added.ok) throw new Error(added.error);
    expect(added.token.startsWith(HTTP_TOKEN_PREFIX)).toBe(true);
    const text = readFileSync(httpTokensPath(dir), "utf8");
    expect(text).not.toContain(added.token);
    expect(text).toContain(hashHttpToken(added.token));
    if (process.platform !== "win32") expect(statSync(httpTokensPath(dir)).mode & 0o777).toBe(0o600);
    expect(readHttpTokens(dir)).toEqual({
      ok: true,
      tokens: [{ name: "phone", role: "member", sha256: hashHttpToken(added.token), createdAt: "2026-11-18T10:00:00.000Z" }],
    });
  });

  it("two tokens never come out the same", () => {
    const a = addHttpToken(dir, "a", "viewer");
    const b = addHttpToken(dir, "b", "viewer");
    expect(a.ok && b.ok && a.token !== b.token).toBe(true);
  });

  it("refuses a duplicate name and a bad name", () => {
    expect(addHttpToken(dir, "phone", "viewer").ok).toBe(true);
    expect(addHttpToken(dir, "phone", "admin")).toMatchObject({ ok: false, error: expect.stringContaining("already exists") });
    expect(addHttpToken(dir, "has space", "admin")).toMatchObject({ ok: false, error: expect.stringContaining("invalid token name") });
    expect(addHttpToken(dir, "", "admin").ok).toBe(false);
  });

  it("remove drops one token and reports an unknown name", () => {
    addHttpToken(dir, "a", "viewer");
    addHttpToken(dir, "b", "admin");
    expect(removeHttpToken(dir, "a")).toEqual({ ok: true });
    const read = readHttpTokens(dir);
    expect(read.ok && read.tokens.map((t) => t.name)).toEqual(["b"]);
    expect(removeHttpToken(dir, "a")).toMatchObject({ ok: false, error: 'no token named "a"' });
  });

  it("never writes over a broken file", () => {
    writeFileSync(httpTokensPath(dir), "{ not json");
    expect(addHttpToken(dir, "a", "viewer")).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(readFileSync(httpTokensPath(dir), "utf8")).toBe("{ not json");
    writeFileSync(httpTokensPath(dir), JSON.stringify({ tokens: [{ name: "x", role: "owner", sha256: "0".repeat(64) }] }));
    expect(readHttpTokens(dir).ok).toBe(false);
  });

  it("the serve source reloads after add and remove, and a broken file yields no tokens", () => {
    const source = createHttpTokenSource(dir);
    expect(source()).toEqual([]);
    addHttpToken(dir, "a", "viewer");
    expect(source().map((t) => t.name)).toEqual(["a"]);
    addHttpToken(dir, "bb", "member");
    expect(source().map((t) => t.name)).toEqual(["a", "bb"]);
    removeHttpToken(dir, "a");
    expect(source().map((t) => t.name)).toEqual(["bb"]);
    writeFileSync(httpTokensPath(dir), "broken");
    expect(source()).toEqual([]);
    rmSync(httpTokensPath(dir));
    expect(source()).toEqual([]);
  });
});
