import { describe, expect, it } from "vitest";

import {
  DEFAULT_SECRET_REF_TIMEOUT_MS,
  EMPTY_SECRET_SOURCES,
  INTERACTIVE_SECRET_REF_TIMEOUT_MS,
  parseSecretRef,
  planSecretRef,
  type SecretSources,
} from "./secret-refs.js";

// ATO-2530: bw on Windows (bw.cmd needs cmd.exe) and a longer default
// timeout for op / bw, which may wait on Touch ID. No real binaries: only plans.
const ENV: NodeJS.ProcessEnv = { PATH: "C:\\bin", ComSpec: "C:\\Windows\\System32\\cmd.exe", BW_SESSION: "s" };

describe("planSecretRef on Windows and timeouts (ATO-2530)", () => {
  it("runs bw through cmd.exe /d /s /c with the item quoted and the line passed verbatim", () => {
    const plan = planSecretRef({ kind: "bw", item: "npm publish", field: "password" }, EMPTY_SECRET_SOURCES, ENV, "win32");
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.argv).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", '"bw get password "npm publish""']);
    expect(plan.verbatim).toBe(true);
    expect(plan.program).toBe("bw");
    expect(plan.env.BW_SESSION).toBe("s");
  });

  it("refuses a bw item cmd.exe would read as syntax, instead of escaping it", () => {
    for (const item of ['a" & calc & "', "100%PATH%", "x^y", "a|b", "a>b", "a!b"]) {
      const plan = planSecretRef({ kind: "bw", item, field: "password" }, EMPTY_SECRET_SOURCES, ENV, "win32");
      expect(typeof plan).toBe("string");
    }
  });

  it("keeps the plain argv elsewhere", () => {
    const plan = planSecretRef({ kind: "bw", item: "npm", field: "totp" }, EMPTY_SECRET_SOURCES, ENV, "darwin");
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.argv).toEqual(["bw", "get", "totp", "npm"]);
    expect(plan.verbatim).toBeUndefined();
  });

  it("gives op and bw 30 s by default and cmd:// helpers 3 s", () => {
    const sources: SecretSources = { ...EMPTY_SECRET_SOURCES, command: ["/opt/helper"] };
    const op = planSecretRef({ kind: "op", ref: "op://a/b/c" }, sources, ENV, "darwin");
    const bw = planSecretRef({ kind: "bw", item: "x", field: "password" }, sources, ENV, "darwin");
    const cmd = planSecretRef({ kind: "command", key: "k" }, sources, ENV, "darwin");
    if (typeof op === "string" || typeof bw === "string" || typeof cmd === "string") throw new Error("plan");
    expect(op.timeoutMs).toBe(INTERACTIVE_SECRET_REF_TIMEOUT_MS);
    expect(bw.timeoutMs).toBe(INTERACTIVE_SECRET_REF_TIMEOUT_MS);
    expect(cmd.timeoutMs).toBe(DEFAULT_SECRET_REF_TIMEOUT_MS);
  });

  it("lets a timeoutMs from the file apply to op too", () => {
    const sources: SecretSources = { ...EMPTY_SECRET_SOURCES, timeoutMs: 8_000, timeoutSet: true };
    const op = planSecretRef({ kind: "op", ref: "op://a/b/c" }, sources, ENV, "darwin");
    if (typeof op === "string") throw new Error(op);
    expect(op.timeoutMs).toBe(8_000);
  });
});

describe("vault:// references (ATO-2530)", () => {
  it("parses mount, path and field", () => {
    expect(parseSecretRef("vault://secret/apps/deploy#token", "K")).toEqual({
      kind: "vault",
      mount: "secret",
      path: "apps/deploy",
      field: "token",
    });
  });

  it("refuses a malformed reference or one that climbs out of the mount", () => {
    for (const bad of ["vault://secret/apps", "vault://secret#token", "vault://secret/../sys/x#t", "vault://secret/a?b#t"]) {
      expect(typeof parseSecretRef(bad, "K")).toBe("string");
    }
  });
});
