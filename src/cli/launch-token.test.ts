import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addHttpToken, hashHttpToken, readHttpTokens, removeHttpToken } from "../http/http-token-store.js";
import {
  issueRunToken,
  LAUNCH_CONFIG_TOKEN_NAME,
  lastingToken,
  launchClientKeyPath,
  runTokenPid,
} from "./launch-token.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-launch-token-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stored(): { name: string; role: string; sha256: string }[] {
  const r = readHttpTokens(dir);
  if (!r.ok) throw new Error(r.error);
  return r.tokens.map((t) => ({ name: t.name, role: t.role, sha256: t.sha256 }));
}

describe("launch tokens (ATO-2451)", () => {
  it("a run token is a member token named for the CLI and pid, and revoke removes it once", () => {
    const issued = issueRunToken(dir, "claude", { pid: 4242, isAlive: () => true });
    if ("error" in issued) throw new Error(issued.error);
    const [entry] = stored();
    expect(entry?.role).toBe("member");
    expect(entry?.name).toMatch(/^launch-claude-4242-[0-9a-f]{8}$/);
    expect(entry?.sha256).toBe(hashHttpToken(issued.token));
    expect(runTokenPid(entry?.name ?? "")).toBe(4242);
    issued.revoke();
    issued.revoke();
    expect(stored()).toEqual([]);
  });

  it("two runs of the same CLI get different tokens and do not revoke each other", () => {
    const a = issueRunToken(dir, "codex", { pid: 10, isAlive: () => true });
    const b = issueRunToken(dir, "codex", { pid: 11, isAlive: () => true });
    if ("error" in a || "error" in b) throw new Error("issue failed");
    expect(a.token).not.toBe(b.token);
    a.revoke();
    expect(stored().map((t) => t.sha256)).toEqual([hashHttpToken(b.token)]);
  });

  it("a new run removes the tokens of runs whose process is gone and keeps the rest", () => {
    addHttpToken(dir, "launch-claude-111-0000abcd", "member");
    addHttpToken(dir, "launch-opencode-222-0000abcd", "member");
    addHttpToken(dir, "phone", "member");
    addHttpToken(dir, LAUNCH_CONFIG_TOKEN_NAME, "member");
    const issued = issueRunToken(dir, "qwen", { pid: 333, isAlive: (pid) => pid === 222 });
    if ("error" in issued) throw new Error(issued.error);
    const names = stored().map((t) => t.name);
    expect(names).not.toContain("launch-claude-111-0000abcd");
    expect(names).toContain("launch-opencode-222-0000abcd");
    expect(names).toContain("phone");
    expect(names).toContain(LAUNCH_CONFIG_TOKEN_NAME);
  });

  it("names that only look like run tokens carry no pid", () => {
    expect(runTokenPid(LAUNCH_CONFIG_TOKEN_NAME)).toBeNull();
    expect(runTokenPid("launch-claude-12")).toBeNull();
    expect(runTokenPid("phone-12-0000abcd")).toBeNull();
  });

  it("the lasting token is kept in an owner-only file and reused while the store has it", () => {
    const first = lastingToken(dir);
    if ("error" in first) throw new Error(first.error);
    expect(readFileSync(launchClientKeyPath(dir), "utf8").trim()).toBe(first.token);
    if (process.platform !== "win32") expect(statSync(launchClientKeyPath(dir)).mode & 0o777).toBe(0o600);
    const again = lastingToken(dir);
    expect(again).toEqual({ token: first.token });
    expect(stored()).toEqual([{ name: LAUNCH_CONFIG_TOKEN_NAME, role: "member", sha256: hashHttpToken(first.token) }]);
  });

  it("a removed lasting token is made again with a new value", () => {
    const first = lastingToken(dir);
    if ("error" in first) throw new Error(first.error);
    removeHttpToken(dir, LAUNCH_CONFIG_TOKEN_NAME);
    const next = lastingToken(dir);
    if ("error" in next) throw new Error(next.error);
    expect(next.token).not.toBe(first.token);
    expect(readFileSync(launchClientKeyPath(dir), "utf8").trim()).toBe(next.token);
    expect(stored()).toHaveLength(1);
  });
});
