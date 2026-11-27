import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { confineReads } from "./confine-reads.js";
import { checkGuestRead, GUEST_READ_REFUSAL_REASON } from "./guest-reads.js";

/** A channel guest's reads (ATO-2221): the working directory, no secrets. */
describe("guest read scope", () => {
  let root: string;
  let home: string;
  let work: string;
  let stateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "guest-read-scope-"));
    home = join(root, "home");
    work = join(home, "project");
    stateDir = join(home, ".atomic-agent");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(join(work, "src"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE KEY");
    writeFileSync(join(stateDir, ".env"), "OPENAI_API_KEY=sk-x");
    writeFileSync(join(work, "README.md"), "hello");
    writeFileSync(join(work, ".env"), "TOKEN=x");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const guest = (workingDir = work) => ({ guest: true, workingDir });
  const opts = () => ({ home, stateDir });
  const refused = (
    tool: string,
    args: Record<string, unknown>,
    ctx = guest(),
  ) => checkGuestRead(tool, args, ctx, opts());

  it("lets a guest read inside the working directory", () => {
    for (const [tool, args] of [
      ["os.fs.read", { path: "README.md" }],
      ["os.fs.read", { path: join(work, "src") }],
      ["os.fs.grep", { pattern: "x" }],
      ["os.fs.list", { path: "src" }],
      ["files.search", { query: "x", folder: "src" }],
      ["os.git.log", {}],
      ["os.git.show", { repo: work, revision: "HEAD" }],
    ] as const) {
      expect(refused(tool, { ...args }), tool).toBeNull();
    }
  });

  it("refuses a guest's read outside the working directory, secret or not", () => {
    for (const [tool, args] of [
      ["os.fs.read", { path: join(home, ".ssh", "id_rsa") }],
      ["os.fs.read", { path: "~/.ssh/id_rsa" }],
      ["os.fs.read", { path: "../.ssh/id_rsa" }],
      ["os.fs.read", { path: "/etc/hosts" }],
      ["os.fs.read", { path: join(stateDir, ".env") }],
      ["os.fs.read", { path: "file:///etc/hosts" }],
      ["os.fs.grep", { pattern: "BEGIN", path: home }],
      ["os.git.log", { repo: home }],
      ["os.git.show", { revision: "HEAD", path: "/etc/hosts" }],
    ] as const) {
      const result = refused(tool, { ...args });
      expect(result, `${tool} ${JSON.stringify(args)}`).not.toBeNull();
      expect(result!.status).toBe("error");
      expect(result!.details.reason).toBe(GUEST_READ_REFUSAL_REASON);
    }
  });

  it("refuses secrets even when the working directory is the home folder", () => {
    for (const [tool, args] of [
      ["os.fs.read", { path: ".ssh/id_rsa" }],
      ["os.fs.read", { path: ".atomic-agent/.env" }],
      ["os.fs.list", { path: ".ssh" }],
      // Walking home would walk `.ssh` and the state directory.
      ["os.fs.grep", { pattern: "sk-" }],
      ["os.fs.glob", { pattern: "**/*" }],
    ] as const) {
      expect(refused(tool, { ...args }, guest(home)), tool).not.toBeNull();
    }
    expect(refused("os.fs.read", { path: "project/README.md" }, guest(home))).toBeNull();
  });

  it("refuses .env files and symlinks that lead out", () => {
    expect(refused("os.fs.read", { path: ".env" })).not.toBeNull();
    symlinkSync(join(home, ".ssh"), join(work, "keys"));
    expect(refused("os.fs.read", { path: "keys/id_rsa" })).not.toBeNull();
  });

  it("refuses .envrc in any case, like .env", () => {
    for (const path of [".envrc", ".ENVRC", "src/.EnvRc", ".ENV.local"]) {
      expect(refused("os.fs.read", { path }), path).not.toBeNull();
    }
  });

  it("refuses git arguments that name files the path checks never see", () => {
    for (const [tool, args] of [
      // `<rev>:<path>` prints a tracked file, `.env` or outside the folder.
      ["os.git.show", { revision: "HEAD:.env" }],
      ["os.git.show", { revision: "HEAD~3:.env" }],
      ["os.git.show", { repo: work, revision: "main:../.ssh/id_rsa" }],
      ["os.git.log", { revisionRange: "HEAD:README.md" }],
      ["os.git.diff", { revisionRange: "HEAD~1:a HEAD:b" }],
      ["os.git.blame", { path: "README.md", revision: "HEAD:x" }],
      ["os.git.branch", { contains: "HEAD:x" }],
      // Pathspec magic (`:/` is the repo top), options, globs, relative secrets.
      ["os.git.diff", { paths: [":/"] }],
      ["os.git.log", { path: ":(top).env" }],
      ["os.git.show", { revision: "--output=/tmp/x" }],
      ["os.git.diff", { paths: ["*.env"] }],
      ["os.git.blame", { path: ".env" }],
      ["os.git.blame", { path: "../.ssh/id_rsa" }],
    ] as const) {
      const result = refused(tool, { ...args });
      expect(result, `${tool} ${JSON.stringify(args)}`).not.toBeNull();
      expect(result!.details.reason).toBe(GUEST_READ_REFUSAL_REASON);
    }
    // A plain revision and a relative file inside still run.
    expect(refused("os.git.blame", { path: "README.md", revision: "HEAD~1" })).toBeNull();
    expect(refused("os.git.log", { revisionRange: "main..HEAD", path: "src" })).toBeNull();
    // The owner is not limited.
    expect(
      checkGuestRead("os.git.show", { revision: "HEAD:.env" }, { workingDir: work }, opts()),
    ).toBeNull();
  });

  it("refuses files.search over the owner's folders", () => {
    expect(refused("files.search", { query: "invoice" })).not.toBeNull();
  });

  it("leaves non-guest sessions alone", () => {
    expect(
      checkGuestRead("os.fs.read", { path: join(home, ".ssh", "id_rsa") }, { workingDir: work }, opts()),
    ).toBeNull();
  });

  it("is enforced at dispatch by confineReads, at any read scope, for git tools too", async () => {
    const registry = new ToolRegistry();
    const ran: string[] = [];
    for (const name of ["os.fs.read", "os.git.log"]) {
      registry.register({
        name,
        description: name,
        readonly: true,
        argsJsonSchema: { type: "object" },
        run: async (args: unknown) => {
          ran.push(name);
          return compressToolResult({ tool: name, status: "ok", output: JSON.stringify(args) });
        },
      } as unknown as Parameters<ToolRegistry["register"]>[0]);
    }
    // No read scope, no ladder: the guest check needs neither.
    confineReads(registry, { grantedDirs: () => [] });
    const ctx = (isGuest: boolean): ToolContext => ({
      workingDir: work,
      sessionId: "s-guest",
      stepIndex: 0,
      signal: new AbortController().signal,
      ...(isGuest ? { guest: true } : {}),
    });
    const secret = { path: join(home, ".ssh", "id_rsa") };
    expect((await registry.invoke("os.fs.read", secret, ctx(true))).status).toBe("error");
    expect((await registry.invoke("os.git.log", { repo: home }, ctx(true))).status).toBe("error");
    expect(ran).toEqual([]);
    expect((await registry.invoke("os.fs.read", { path: "README.md" }, ctx(true))).status).toBe("ok");
    expect((await registry.invoke("os.fs.read", secret, ctx(false))).status).toBe("ok");
    expect(ran).toEqual(["os.fs.read", "os.fs.read"]);
  });
});
