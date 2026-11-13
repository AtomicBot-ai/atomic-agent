import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "./approval-gate.js";
import {
  ApprovalRulesFormatError,
  buildAlwaysRule,
  canGrantAlways,
  describeAlwaysRule,
  matchRules,
  parseApprovalRule,
  parseApprovalRulesFile,
  type ApprovalRule,
} from "./approval-rules.js";

function rule(fields: Partial<ApprovalRule> & Pick<ApprovalRule, "decision">): ApprovalRule {
  return { id: `r_${Math.random().toString(16).slice(2, 10)}`, createdAt: "", source: "user", ...fields };
}

function shell(argv: string[], extra: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "a",
    sessionId: "s",
    tool: "os.shell.run",
    category: "shell",
    reason: "r",
    commandShape: argv[0],
    commandArgv: argv,
    ...extra,
  };
}

describe("parseApprovalRulesFile", () => {
  it("throws a format error for something that is not a rules file", () => {
    expect(() => parseApprovalRulesFile([], "global")).toThrow(ApprovalRulesFormatError);
    expect(() => parseApprovalRulesFile({ rules: {} }, "global")).toThrow(ApprovalRulesFormatError);
    expect(() => parseApprovalRulesFile({ version: 2, rules: [] }, "global")).toThrow(/version/);
  });

  it("skips a bad entry with a warning and keeps the others", () => {
    const parsed = parseApprovalRulesFile(
      {
        version: 1,
        rules: [
          { id: "r_ok", decision: "deny", commandPrefix: ["rm"] },
          { id: "r_bad", decision: "maybe" },
          { id: "r_cat", decision: "ask", category: "no_such_category" },
          { id: "r_rel", decision: "deny", path: "relative/dir" },
        ],
      },
      "global",
    );
    expect(parsed.rules.map((r) => r.id)).toEqual(["r_ok"]);
    expect(parsed.warnings).toHaveLength(3);
  });

  it("ignores allow rules in a project file: the model can write there", () => {
    const parsed = parseApprovalRulesFile(
      {
        rules: [
          { decision: "allow", category: "shell" },
          { decision: "deny", commandPrefix: ["git", "push"] },
          { decision: "ask", tool: "os.fs.write" },
        ],
      },
      "project",
    );
    expect(parsed.rules.map((r) => r.decision)).toEqual(["deny", "ask"]);
    expect(parsed.warnings.join("\n")).toMatch(/cannot allow/);
  });

  it("refuses an allow rule that names nothing", () => {
    expect(parseApprovalRule({ decision: "allow" })).toMatch(/must name/);
    expect(parseApprovalRule({ decision: "allow", path: "/tmp" })).toMatch(/must name/);
    // A deny of everything is a person's choice, not an escalation.
    expect(typeof parseApprovalRule({ decision: "deny" })).toBe("object");
  });

  it("gives a rule without an id a stable one", () => {
    const a = parseApprovalRule({ decision: "deny", commandPrefix: ["rm"] });
    const b = parseApprovalRule({ decision: "deny", commandPrefix: ["rm"] });
    expect(typeof a).toBe("object");
    expect((a as ApprovalRule).id).toBe((b as ApprovalRule).id);
    expect((a as ApprovalRule).id).toMatch(/^r_[0-9a-f]{8}$/);
  });

  it("rejects a commandPrefix on a non-shell category", () => {
    expect(
      parseApprovalRule({ decision: "deny", category: "http", commandPrefix: ["curl"] }),
    ).toMatch(/shell commands only/);
  });
});

describe("matchRules", () => {
  it("matches a command prefix token by token, argv[0] by basename", () => {
    const rules = [rule({ decision: "allow", commandPrefix: ["git", "status"] })];
    expect(matchRules(rules, shell(["git", "status", "-s"]))?.decision).toBe("allow");
    expect(matchRules(rules, shell(["/usr/bin/Git", "status"]))?.decision).toBe("allow");
    expect(matchRules(rules, shell(["git", "push"]))).toBeNull();
    expect(matchRules(rules, shell(["git"]))).toBeNull();
  });

  it("never matches a prefix rule against a request without argv", () => {
    const rules = [rule({ decision: "allow", commandPrefix: ["git"] })];
    const compound = shell(["git"]);
    delete compound.commandArgv;
    expect(matchRules(rules, compound)).toBeNull();
  });

  describe("commandSegments", () => {
    const line = (segments: string[][], extra: Partial<ApprovalRequest> = {}) => {
      const request = shell(["x"], { commandSegments: segments, ...extra });
      delete request.commandArgv;
      return request;
    };

    it("a deny or ask matches any command of the line, by basename", () => {
      const deny = [rule({ decision: "deny", commandPrefix: ["npm", "publish"] })];
      const ask = [rule({ decision: "ask", commandPrefix: ["git", "push"] })];
      expect(matchRules(deny, line([["echo", "a"], ["npm", "publish"]]))?.decision).toBe("deny");
      expect(matchRules(ask, line([["/usr/bin/git", "push"]]))?.decision).toBe("ask");
    });

    it("a deny or ask matches a script piped into a shell whatever its prefix, an allow does not", () => {
      const piped = line([["printf", "x"], ["sh"]], { commandUnreadable: true });
      expect(
        matchRules([rule({ decision: "deny", commandPrefix: ["npm", "publish"] })], piped)?.decision,
      ).toBe("deny");
      expect(
        matchRules([rule({ decision: "ask", commandPrefix: ["rm"] })], piped)?.decision,
      ).toBe("ask");
      expect(matchRules([rule({ decision: "allow", commandPrefix: ["sh"] })], piped)).toBeNull();
      expect(
        matchRules([rule({ decision: "deny", commandPrefix: ["rm"] })], line([["printf", "x"], ["sh"]])),
      ).toBeNull();
    });

    it("an allow never matches through segments", () => {
      const allow = [rule({ decision: "allow", commandPrefix: ["git"] })];
      expect(matchRules(allow, line([["git", "status"]]))).toBeNull();
    });

    it("a shell-category deny reaches a dangerous command, an allow does not", () => {
      const dangerous = line([["rm", "-rf", "x"]], { category: "shell_dangerous" });
      expect(
        matchRules([rule({ decision: "deny", category: "shell", commandPrefix: ["rm"] })], dangerous)?.decision,
      ).toBe("deny");
      expect(
        matchRules([rule({ decision: "allow", category: "shell", commandPrefix: ["rm"] })], dangerous),
      ).toBeNull();
    });

    it("a deny written for os.shell.run also covers verify.run", () => {
      const rules = [rule({ decision: "deny", tool: "os.shell.run", commandPrefix: ["npm", "publish"] })];
      expect(
        matchRules(rules, line([["npm", "publish"]], { tool: "verify.run" }))?.decision,
      ).toBe("deny");
    });
  });

  it("puts deny over ask over allow, whatever the order in the file", () => {
    const allow = rule({ decision: "allow", commandPrefix: ["git"] });
    const ask = rule({ decision: "ask", commandPrefix: ["git", "push"] });
    const deny = rule({ decision: "deny", commandPrefix: ["git", "push", "--force"] });
    const rules = [allow, ask, deny];
    expect(matchRules(rules, shell(["git", "log"]))).toEqual({ decision: "allow", rule: allow });
    expect(matchRules(rules, shell(["git", "push"]))).toEqual({ decision: "ask", rule: ask });
    expect(matchRules(rules, shell(["git", "push", "--force"]))).toEqual({ decision: "deny", rule: deny });
  });

  it("never lets an allow apply to a category that is never granted", () => {
    const rules = [rule({ decision: "allow", tool: "os.fs.write" })];
    const trust: ApprovalRequest = {
      approvalId: "a",
      sessionId: "s",
      tool: "os.fs.write",
      category: "trust_config",
      reason: "write config.json",
    };
    expect(matchRules(rules, trust)).toBeNull();
    expect(matchRules(rules, { ...trust, category: "state_secret" })).toBeNull();
    // An ask or a deny still applies there.
    expect(matchRules([rule({ decision: "deny", tool: "os.fs.write" })], trust)?.decision).toBe("deny");
  });

  it("scopes a project rule to sessions inside the project", () => {
    const rules = [rule({ decision: "allow", commandPrefix: ["npm", "test"], project: "/work/app" })];
    expect(matchRules(rules, shell(["npm", "test"]), { workdir: "/work/app" })?.decision).toBe("allow");
    expect(matchRules(rules, shell(["npm", "test"]), { workdir: "/work/app/pkg" })?.decision).toBe("allow");
    expect(matchRules(rules, shell(["npm", "test"]), { workdir: "/work/other" })).toBeNull();
    expect(matchRules(rules, shell(["npm", "test"]), { workdir: "/work/app-2" })).toBeNull();
  });

  it("with no known workdir, a project allow does not apply but a project deny does", () => {
    const allow = [rule({ decision: "allow", commandPrefix: ["npm"], project: "/work/app" })];
    const deny = [rule({ decision: "deny", commandPrefix: ["npm"], project: "/work/app" })];
    expect(matchRules(allow, shell(["npm", "test"]))).toBeNull();
    expect(matchRules(deny, shell(["npm", "test"]))?.decision).toBe("deny");
  });

  it("needs every path a request names inside a path rule", () => {
    const rules = [rule({ decision: "allow", category: "fs_write_workspace", path: "/work/app" })];
    const write = (targets: string[]): ApprovalRequest => ({
      approvalId: "a",
      sessionId: "s",
      tool: "os.fs.write",
      category: "fs_write_workspace",
      reason: "r",
      targetPaths: targets,
    });
    expect(matchRules(rules, write(["/work/app/a.txt"]))?.decision).toBe("allow");
    expect(matchRules(rules, write(["/work/app/a.txt", "/etc/hosts"]))).toBeNull();
    expect(matchRules(rules, write(["/work/app/../secret"]))).toBeNull();
    expect(matchRules(rules, write([]))).toBeNull();
  });
});

describe("Allow always", () => {
  it("keys a shell rule on the binary and its subcommand, in the session's project", () => {
    expect(buildAlwaysRule(shell(["git", "status", "-s"], { workdir: "/work/app" }))).toEqual({
      decision: "allow",
      tool: "os.shell.run",
      category: "shell",
      commandPrefix: ["git", "status"],
      project: "/work/app",
      source: "prompt",
    });
    // A flag or a path is not a subcommand: the binary alone.
    expect(buildAlwaysRule(shell(["ls", "-la"], { workdir: "/w" }))?.commandPrefix).toEqual(["ls"]);
    expect(buildAlwaysRule(shell(["cat", "./a.txt"], { workdir: "/w" }))?.commandPrefix).toEqual(["cat"]);
  });

  it("keys any other request on its tool and category", () => {
    const request: ApprovalRequest = {
      approvalId: "a",
      sessionId: "s",
      tool: "os.proc.kill",
      category: "proc_kill",
      reason: "r",
      workdir: "/w",
    };
    expect(buildAlwaysRule(request)).toEqual({
      decision: "allow",
      tool: "os.proc.kill",
      category: "proc_kill",
      project: "/w",
      source: "prompt",
    });
    expect(describeAlwaysRule(request)).toBe("Always allow os.proc.kill (process kill) in this project");
  });

  describe("HTTP requests are saved for one origin (ATO-1471)", () => {
    const http = (grantKey?: string): ApprovalRequest => ({
      approvalId: "a",
      sessionId: "s",
      tool: "os.http.request",
      category: "http",
      reason: "POST https://api.example.com/x",
      workdir: "/w",
      ...(grantKey !== undefined ? { grantKey } : {}),
    });

    it("saves the origin the prompt was about and names it in the label", () => {
      const request = http("https://api.example.com");
      expect(canGrantAlways(request)).toBe(true);
      expect(buildAlwaysRule(request)).toEqual({
        decision: "allow",
        tool: "os.http.request",
        category: "http",
        origin: "https://api.example.com",
        project: "/w",
        source: "prompt",
      });
      expect(describeAlwaysRule(request)).toBe(
        "Always allow os.http.request (HTTP request) to https://api.example.com in this project",
      );
    });

    it("is not offered when the request names no origin", () => {
      expect(canGrantAlways(http())).toBe(false);
      expect(buildAlwaysRule(http())).toBeNull();
      expect(canGrantAlways(http("not a url"))).toBe(false);
    });

    it("the saved rule matches that origin only", () => {
      const saved = parseApprovalRule({ ...buildAlwaysRule(http("https://api.example.com"))! });
      if (typeof saved === "string") throw new Error(saved);
      const ctx = { workdir: "/w" };
      expect(matchRules([saved], http("https://api.example.com"), ctx)?.decision).toBe("allow");
      expect(matchRules([saved], http("https://evil.example"), ctx)).toBeNull();
      expect(matchRules([saved], http("https://api.example.com:8443"), ctx)).toBeNull();
      expect(matchRules([saved], http("http://api.example.com"), ctx)).toBeNull();
      expect(matchRules([saved], http(), ctx)).toBeNull();
    });

    it("parses an origin field to its normal form and rejects a bad one", () => {
      const ok = parseApprovalRule({
        decision: "deny",
        tool: "os.http.request",
        origin: "https://API.Example.com/some/path",
      });
      expect(typeof ok === "string" ? ok : ok.origin).toBe("https://api.example.com");
      expect(parseApprovalRule({ decision: "deny", origin: "api.example.com" })).toMatch(/origin/);
      expect(parseApprovalRule({ decision: "deny", origin: "ftp://x.example" })).toMatch(/origin/);
      expect(parseApprovalRule({ decision: "deny", origin: 5 })).toMatch(/origin/);
    });

    it("gives rules that differ only by origin different ids", () => {
      const a = parseApprovalRule({ decision: "deny", tool: "os.http.request", origin: "https://a.example" });
      const b = parseApprovalRule({ decision: "deny", tool: "os.http.request", origin: "https://b.example" });
      const none = parseApprovalRule({ decision: "deny", tool: "os.http.request" });
      if (typeof a === "string" || typeof b === "string" || typeof none === "string") throw new Error("parse");
      expect(a.id).not.toBe(b.id);
      expect(a.id).not.toBe(none.id);
    });
  });

  describe("path-wide categories", () => {
    const base = { approvalId: "a", sessionId: "s", reason: "r", workdir: "/w" };

    it("a read outside the project is saved for the directory the prompt named", () => {
      const request: ApprovalRequest = {
        ...base,
        tool: "os.fs.read",
        category: "fs_read_outside",
        affectedResources: ["/data/reports"],
      };
      expect(buildAlwaysRule(request)).toMatchObject({ path: "/data/reports", project: "/w" });
      expect(describeAlwaysRule(request)).toContain("under /data/reports");
      const rules = [rule({ decision: "allow", tool: "os.fs.read", category: "fs_read_outside", path: "/data/reports" })];
      expect(matchRules(rules, { ...request, affectedResources: ["/home/me/.ssh"] })).toBeNull();
    });

    it("a read with no directory named is not offered", () => {
      expect(canGrantAlways({ ...base, tool: "os.fs.read", category: "fs_read_outside" })).toBe(false);
    });

    it("a write in the home directory is not offered", () => {
      const request: ApprovalRequest = { ...base, tool: "os.fs.write", category: "fs_write_home" };
      expect(canGrantAlways(request)).toBe(false);
      expect(buildAlwaysRule(request)).toBeNull();
    });
  });

  it("is offered only for grantable requests with a project and, for shell, an argv", () => {
    expect(canGrantAlways(shell(["git", "status"], { workdir: "/w" }))).toBe(true);
    expect(canGrantAlways(shell(["git", "status"]))).toBe(false);
    const noArgv = shell(["git"], { workdir: "/w" });
    delete noArgv.commandArgv;
    expect(canGrantAlways(noArgv)).toBe(false);
    expect(
      canGrantAlways({
        approvalId: "a",
        sessionId: "s",
        tool: "os.fs.write",
        category: "trust_config",
        reason: "r",
        workdir: "/w",
      }),
    ).toBe(false);
    expect(buildAlwaysRule(noArgv)).toBeNull();
  });

  it("describes the shell rule by its prefix", () => {
    expect(describeAlwaysRule(shell(["git", "status", "-s"], { workdir: "/w" }))).toBe(
      'Always allow "git status" in this project',
    );
  });
});
