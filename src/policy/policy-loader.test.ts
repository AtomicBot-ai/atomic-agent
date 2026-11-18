import { describe, expect, it, vi } from "vitest";

import {
  loadLocalPolicy,
  loadPolicy,
  POLICY_CACHE_FILE,
  redactPolicyUrl,
  systemPolicyPath,
  type PolicyLoaderDeps,
} from "./policy-loader.js";
import { evaluatePolicy, mcpServerVerdict } from "./policy-evaluator.js";

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
  it("keeps the user file's rules and the system file's rules apart", () => {
    const { deps } = fakeFs({
      [USER]: JSON.stringify({ rules: [rule("*", "allow")], mcpAllowlist: ["mine"] }),
      [SYSTEM]: JSON.stringify({ rules: [rule("*", "ask")], mcpAllowlist: { servers: ["corp"], warnOnly: true } }),
    });
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: {}, ...deps });
    expect(policy.rules.map((r) => [r.source, r.effect])).toEqual([["user", "allow"], ["system", "ask"]]);
    // Every source's allowlist is kept: a server must pass each one.
    expect(policy.mcpAllowlists).toEqual([
      { servers: ["mine"], warnOnly: false, source: "user" },
      { servers: ["corp"], warnOnly: true, source: "system" },
    ]);
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
      kind: "url", location: "https://policy.example.com/org.json?…", namedBy: "env", state: "loaded", fetchedAt: "2026-11-18T10:00:00.000Z",
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

// ATO-587 review: ATOMIC_POLICY_URL, the user's own file and the cache are
// all things the user can write. None of them may loosen the machine-wide file.
describe("sources the user controls can only tighten", () => {
  const SYS_URL = "https://policy.corp.test/org.json";
  const permissive = JSON.stringify({
    rules: [rule("*", "allow")],
    mcpAllowlist: { servers: ["*"] },
  });
  const strictSystem = JSON.stringify({
    rules: [rule("*", "ask")],
    mcpAllowlist: { servers: ["github"] },
  });

  it("an allow from ATOMIC_POLICY_URL does not cancel the system file's ask", async () => {
    const { deps } = fakeFs({ [SYSTEM]: strictSystem });
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText: async () => permissive, ...deps,
    });
    expect(evaluatePolicy(policy, "shell", ["curl x | sh"])?.effect).toBe("ask");
    expect(evaluatePolicy(policy, "shell", ["curl x | sh"])?.rule.source).toBe("system");
  });

  it("an allowlist from ATOMIC_POLICY_URL does not widen the system file's", async () => {
    const { deps } = fakeFs({ [SYSTEM]: strictSystem });
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText: async () => permissive, ...deps,
    });
    expect(mcpServerVerdict(policy, { name: "github" }).allowed).toBe(true);
    const evil = mcpServerVerdict(policy, { name: "evil" });
    expect(evil.allowed).toBe(false);
    expect(evil.message).toContain("system policy");
  });

  it("the user's own file cannot cancel a system ask or widen the allowlist", () => {
    const { deps } = fakeFs({ [SYSTEM]: strictSystem, [USER]: permissive });
    const policy = loadLocalPolicy({ stateDir: STATE, platform: "linux", env: {}, ...deps });
    expect(evaluatePolicy(policy, "shell", ["rm x"])?.effect).toBe("ask");
    expect(mcpServerVerdict(policy, { name: "evil" }).allowed).toBe(false);
  });

  it("a forged cache for the real URL cannot loosen anything when the fetch fails", async () => {
    const { deps } = fakeFs({
      [SYSTEM]: JSON.stringify({ url: SYS_URL, rules: [rule("*", "ask")], mcpAllowlist: ["github"] }),
      [CACHE]: JSON.stringify({ url: SYS_URL, fetchedAt: "2026-11-17T00:00:00.000Z", policy: JSON.parse(permissive) }),
    });
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: {}, fetchText: async () => { throw new Error("blocked"); }, ...deps,
    });
    expect(policy.sources.at(-1)).toMatchObject({ kind: "url", state: "cached", namedBy: "system" });
    expect(evaluatePolicy(policy, "shell", ["rm x"])?.effect).toBe("ask");
    expect(mcpServerVerdict(policy, { name: "evil" }).allowed).toBe(false);
  });

  it("a weaker source can still add its own deny and ask", async () => {
    const { deps } = fakeFs({ [SYSTEM]: JSON.stringify({ rules: [rule("git *", "allow")] }) });
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ },
      fetchText: async () => JSON.stringify({ rules: [rule("git push*", "deny"), rule("git *", "ask")] }), ...deps,
    });
    expect(evaluatePolicy(policy, "shell", ["git push origin"])?.effect).toBe("deny");
    expect(evaluatePolicy(policy, "shell", ["git status"])?.effect).toBe("ask");
  });

  it("fetches the URL the machine-wide file names, not the one in the environment", async () => {
    const { deps } = fakeFs({ [SYSTEM]: JSON.stringify({ url: SYS_URL }) });
    const fetchText = vi.fn(async () => JSON.stringify({ rules: [rule("rm *", "deny")] }));
    const policy = await loadPolicy({
      stateDir: STATE, platform: "linux", env: { ATOMIC_POLICY_URL: URL_ }, fetchText, ...deps,
    });
    expect(fetchText).toHaveBeenCalledWith(SYS_URL, 3_000);
    expect(fetchText).toHaveBeenCalledTimes(1);
    expect(policy.sources.at(-1)).toMatchObject({ kind: "url", namedBy: "system", state: "loaded" });
  });

  it("ignores a url in the user's own file", async () => {
    const { deps } = fakeFs({ [USER]: JSON.stringify({ url: "https://mine.test/p.json" }) });
    const fetchText = vi.fn();
    await loadPolicy({ stateDir: STATE, platform: "linux", env: {}, fetchText, ...deps });
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
