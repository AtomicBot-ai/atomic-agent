import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maskSecrets } from "../../../error-reporting/secret-detector.js";
import {
  createFileTokenStore,
  subscriptionTokenPath,
} from "./credential-store.js";

// The real helper is a no-op off Windows; only the write path matters here.
vi.mock("../../../config/windows-acl.js", () => ({ restrictWindowsAcl: vi.fn() }));

const posix = process.platform !== "win32";
const modeOf = (path: string): number => statSync(path).mode & 0o777;

const jwt = (payload: Record<string, unknown>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU",
  ].join(".");

const TOKENS = {
  accessToken: jwt({ sub: "user-1", exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  refreshToken: "rt_0aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT",
  idToken: jwt({ email: "a@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
  expiresAt: 2_000_000_000_000,
};

describe("createFileTokenStore", () => {
  let stateDir: string;
  let path: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "oauth-store-"));
    path = subscriptionTokenPath(stateDir, "chatgpt");
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps the file under <stateDir>/auth, not in config.json", () => {
    expect(path).toBe(join(stateDir, "auth", "chatgpt.json"));
  });

  it("reads back what it wrote", async () => {
    const store = createFileTokenStore({ path, now: () => 42 });
    await store.save(TOKENS);
    await expect(store.load()).resolves.toEqual(TOKENS);
    expect(store.savedAt()).toBe(42);
  });

  it.runIf(posix)("writes the file 0600 and its folder 0700", async () => {
    const store = createFileTokenStore({ path });
    await store.save(TOKENS);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(stateDir, "auth"))).toBe(0o700);
  });

  it("writes only the token fields", async () => {
    const store = createFileTokenStore({ path });
    await store.save({ ...TOKENS, extra: "nope" } as typeof TOKENS);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(file.tokens).sort()).toEqual(["accessToken", "expiresAt", "idToken", "refreshToken"]);
  });

  it.runIf(posix)("tightens a wider file on read and says so without the token text", async () => {
    const store = createFileTokenStore({ path });
    await store.save(TOKENS);
    chmodSync(path, 0o644);
    const warnings: string[] = [];
    const reader = createFileTokenStore({ path, onWarning: (m) => warnings.push(m) });
    await expect(reader.load()).resolves.toEqual(TOKENS);
    expect(modeOf(path)).toBe(0o600);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("644");
    expect(warnings[0]).not.toContain(TOKENS.refreshToken);
  });

  it("reads a missing file as signed out", async () => {
    const store = createFileTokenStore({ path });
    await expect(store.load()).resolves.toBeNull();
    expect(store.savedAt()).toBeNull();
  });

  it("reads a damaged file as signed out", async () => {
    mkdirSync(join(stateDir, "auth"), { recursive: true });
    writeFileSync(path, "{not json", { mode: 0o600 });
    await expect(createFileTokenStore({ path }).load()).resolves.toBeNull();
    writeFileSync(path, JSON.stringify({ version: 1, tokens: { accessToken: "" } }), { mode: 0o600 });
    await expect(createFileTokenStore({ path }).load()).resolves.toBeNull();
  });

  it("deletes the file on clear, and clearing twice is fine", async () => {
    const store = createFileTokenStore({ path });
    await store.save(TOKENS);
    await store.clear();
    expect(existsSync(path)).toBe(false);
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.load()).resolves.toBeNull();
  });

  it("the secret detector masks every token in the file's text", async () => {
    const store = createFileTokenStore({ path });
    await store.save(TOKENS);
    const masked = maskSecrets(readFileSync(path, "utf8"));
    expect(masked).not.toContain(TOKENS.accessToken);
    expect(masked).not.toContain(TOKENS.idToken);
    expect(masked).not.toContain(TOKENS.refreshToken);
    expect(masked).toContain("[redacted:");
  });

  it("the secret detector masks a bearer header carrying the access token", () => {
    const masked = maskSecrets(`authorization: Bearer ${TOKENS.accessToken}`);
    expect(masked).not.toContain(TOKENS.accessToken);
  });
});
