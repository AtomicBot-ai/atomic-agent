import { describe, expect, it, vi } from "vitest";

import {
  loadLocalPolicy,
  loadPolicy,
  POLICY_CACHE_FILE,
  redactPolicyUrl,
  systemPolicyPath,
  type PolicyLoaderDeps,
} from "./policy-loader.js";

const STATE = "/state";
const SYSTEM = "/etc/atomic-agent/policy.json";
const USER = "/state/policy.json";
const CACHE = `/state/${POLICY_CACHE_FILE}`;
const URL_ = "https://policy.example.com/org.json?token=abc";

function fakeFs(files: Record<string, string>) {
  const written: Record<string, string> = {};
  const deps: Pick<PolicyLoaderDeps, "readText" | "writeText"> = {
    readText: (p) => written[p] ?? files[p] ?? null,
    writeText: (p, text) => {
      written[p] = text;
    },
  };
  return { deps, written };
}

const rule = (resource: string, effect: string) => ({ action: "shell", resource, effect });

describe("systemPolicyPath", () => {
  it("names the machine-wide file per platform", () => {
    expect(systemPolicyPath("darwin", {})).toBe("/Library/Application Support/AtomicAgent/policy.json");
    expect(systemPolicyPath("linux", {})).toBe(SYSTEM);
    expect(systemPolicyPath("win32", { ProgramData: "D:\\PD" })).toBe("D:\\PD\\AtomicAgent\\policy.json");
    expect(systemPolicyPath("win32", {})).toBe("C:\\ProgramData\\AtomicAgent\\policy.json");
  });
});

describe("loadLocalPolicy", () => {
  it("evaluates the user file first and the system file after it", () => {
    const { deps } = fakeFs({
      [USER]: JSON.stringify({ rules: [rule("*", "allow")], mcpAllowlist: ["mine"] }),
      [SYSTEM]: JSON.stringify({ rules: [rule("*", "ask")], mcpAllowlist: { servers: ["corp"], warnOnly: true } }),
    });
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: {}, ...deps });
    expect(policy.rules.map((r) => [r.source, r.effect])).toEqual([["user", "allow"], ["system", "ask"]]);
    // The allowlist comes from the strongest source that sets one.
    expect(policy.mcpAllowlist).toEqual({ servers: ["corp"], warnOnly: true, source: "system" });
    expect(policy.sources.map((s) => [s.kind, s.state])).toEqual([["user", "loaded"], ["system", "loaded"]]);
  });

  it("ignores a broken file and reports it as invalid", () => {
    const { deps } = fakeFs({ [SYSTEM]: "{ not json", [USER]: JSON.stringify({ rules: [rule("rm *", "deny")] }) });
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: {}, ...deps });
    expect(policy.rules).toHaveLength(1);
    const system = policy.sources.find((s) => s.kind === "system");
    expect(system?.state).toBe("invalid");
    expect(system?.error).toMatch(/not valid JSON/);
  });

  it("reports missing files and uses no rules", () => {
    const { deps } = fakeFs({});
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: {}, ...deps });
    expect(policy.rules).toEqual([]);
    expect(policy.sources.every((s) => s.state === "missing")).toBe(true);
  });

  it("uses the cached URL copy without fetching", () => {
    const { deps } = fakeFs({
      [CACHE]: JSON.stringify({ url: URL_, fetchedAt: "2026-11-01T00:00:00.000Z", policy: { rules: [rule("*", "deny")] } }),
    });
    const fetchText = vi.fn();
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText, ...deps });
    expect(fetchText).not.toHaveBeenCalled();
    expect(policy.rules[0]?.source).toBe("url");
    expect(policy.sources.at(-1)).toMatchObject({ kind: "url", state: "cached", fetchedAt: "2026-11-01T00:00:00.000Z" });
  });
});

describe("loadPolicy with ATOMIC_POLICY_URL", () => {
  it("fetches the URL, puts its rules last and caches the good copy", async () => {
    const { deps, written } = fakeFs({ [SYSTEM]: JSON.stringify({ rules: [rule("*", "ask")] }) });
    const fetchText = vi.fn(async () => JSON.stringify({ rules: [rule("git *", "allow")] }));
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText,
      now: () => new Date("2026-11-18T10:00:00.000Z"), ...deps,
    });
    expect(fetchText).toHaveBeenCalledWith(URL_, 3_000);
    expect(policy.rules.map((r) => r.source)).toEqual(["system", "url"]);
    expect(policy.sources.at(-1)).toEqual({
      kind: "url", location: "https://policy.example.com/org.json?…", state: "loaded", fetchedAt: "2026-11-18T10:00:00.000Z",
    });
    expect(JSON.parse(written[CACHE]!)).toMatchObject({ url: URL_, fetchedAt: "2026-11-18T10:00:00.000Z" });
  });

  it("falls back to the cached copy when offline, without throwing", async () => {
    const { deps } = fakeFs({
      [CACHE]: JSON.stringify({ url: URL_, fetchedAt: "2026-11-17T00:00:00.000Z", policy: { rules: [rule("rm *", "deny")] } }),
    });
    const fetchText = vi.fn(async () => { throw new Error("getaddrinfo ENOTFOUND"); });
    const policy = await loadPolicy({ stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText, ...deps });
    expect(policy.rules).toHaveLength(1);
    expect(policy.sources.at(-1)).toMatchObject({ state: "cached", error: "getaddrinfo ENOTFOUND" });
  });

  it("falls back to the cache when the server sends a bad policy", async () => {
    const { deps } = fakeFs({
      [CACHE]: JSON.stringify({ url: URL_, fetchedAt: "2026-11-17T00:00:00.000Z", policy: { rules: [rule("rm *", "deny")] } }),
    });
    const fetchText = vi.fn(async () => JSON.stringify({ rules: [{ action: "nope" }] }));
    const policy = await loadPolicy({ stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText, ...deps });
    expect(policy.rules[0]?.effect).toBe("deny");
    expect(policy.sources.at(-1)?.state).toBe("cached");
  });

  it("ignores a cached copy of another URL and reports the URL unreachable", async () => {
    const { deps } = fakeFs({
      [CACHE]: JSON.stringify({ url: "https://other.example.com/p.json", fetchedAt: "x", policy: { rules: [rule("*", "deny")] } }),
    });
    const fetchText = vi.fn(async () => { throw new Error("timeout"); });
    const policy = await loadPolicy({ stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText, ...deps });
    expect(policy.rules).toEqual([]);
    expect(policy.sources.at(-1)).toMatchObject({ kind: "url", state: "unreachable", error: "timeout" });
  });

  it("still loads when the cache cannot be written", async () => {
    const fetchText = vi.fn(async () => JSON.stringify({ rules: [rule("*", "ask")] }));
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText,
      readText: () => null, writeText: () => { throw new Error("EACCES"); },
    });
    expect(policy.rules).toHaveLength(1);
  });

  it("does not fetch when the variable is unset or blank", async () => {
    const fetchText = vi.fn();
    await loadPolicy({ stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: "  " }, fetchText, readText: () => null });
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe("redactPolicyUrl", () => {
  it("drops the query, which may carry a token", () => {
    expect(redactPolicyUrl("https://a.example/p.json?key=s3cret")).toBe("https://a.example/p.json?…");
    expect(redactPolicyUrl("https://a.example/p.json")).toBe("https://a.example/p.json");
    expect(redactPolicyUrl("not a url")).toBe("(invalid URL)");
  });
});
