import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GuardVerdict } from "../shell-command-guard/index.js";
import { shellSecurityCheck } from "./shell-security-check.js";

const safe = { action: "allow", rule: "safe.echo", reason: "echo" } as GuardVerdict;

describe("shellSecurityCheck (ATO-2505)", () => {
  it("forces the gate for a write into ~/.ssh even when the guard says safe", () => {
    const check = shellSecurityCheck(safe, [join(homedir(), ".ssh", "authorized_keys")], "/tmp");
    expect(check).toMatchObject({
      forcesGate: true,
      askEveryLevel: true,
      finding: { rule: "dangerous.write_startup_file", confidence: 1 },
    });
  });

  it("passes the guard's credential finding and confidence through", () => {
    const verdict = {
      action: "approval_required",
      rule: "dangerous.read_credentials",
      reason: "reads ~/.ssh/id_rsa",
      confidence: 0.9,
      askEveryLevel: true,
    } as GuardVerdict;
    expect(shellSecurityCheck(verdict, [], "/tmp")).toEqual({
      forcesGate: false,
      askEveryLevel: true,
      finding: { rule: "dangerous.read_credentials", reason: "reads ~/.ssh/id_rsa", confidence: 0.9 },
    });
  });

  it("finds nothing for a safe command writing into the project", () => {
    expect(shellSecurityCheck(safe, ["/tmp/project/x.txt"], "/tmp/project")).toEqual({
      forcesGate: false,
      askEveryLevel: false,
    });
  });
});
