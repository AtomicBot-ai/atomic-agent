import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { httpTokensPath } from "../http/http-token-store.js";
import { httpCommand } from "./http-command.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atag-http-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await httpCommand(args, {
    write: (t) => { out += t; },
    writeErr: (t) => { err += t; },
    stateDir: () => dir,
  });
  return { code, out, err };
}

describe("atag http tokens (ATO-583)", () => {
  it("add prints the token once on stdout; list never shows it", async () => {
    const added = await run(["tokens", "add", "phone", "--role", "member"]);
    expect(added.code).toBe(0);
    const token = added.out.trim();
    expect(token).toMatch(/^atag_[A-Za-z0-9_-]{43}$/);
    expect(added.err).toContain('Token "phone" (member: read + chat) added');
    expect(readFileSync(httpTokensPath(dir), "utf8")).not.toContain(token);

    const listed = await run(["tokens", "list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/^phone\s+member\s+\d{4}-/);
    expect(listed.out).not.toContain(token);
  });

  it("accepts --role=<role>", async () => {
    expect((await run(["tokens", "add", "ci", "--role=viewer"])).code).toBe(0);
    expect((await run(["tokens", "list"])).out).toMatch(/^ci\s+viewer/);
  });

  it("remove revokes; a second remove is a failure, not a usage error", async () => {
    await run(["tokens", "add", "phone", "--role", "admin"]);
    expect(await run(["tokens", "remove", "phone"])).toMatchObject({ code: 0, out: 'Removed token "phone".\n' });
    expect((await run(["tokens", "list"])).out).toContain("No named tokens");
    expect(await run(["tokens", "remove", "phone"])).toMatchObject({ code: 1, err: 'http: no token named "phone"\n' });
  });

  it("a duplicate name fails with 1", async () => {
    await run(["tokens", "add", "phone", "--role", "admin"]);
    expect((await run(["tokens", "add", "phone", "--role", "viewer"])).code).toBe(1);
  });

  it.each([
    [[]],
    [["nope"]],
    [["tokens"]],
    [["tokens", "rotate"]],
    [["tokens", "add"]],
    [["tokens", "add", "phone"]],
    [["tokens", "add", "phone", "--role", "owner"]],
    [["tokens", "add", "phone", "--role", "admin", "extra"]],
    [["tokens", "add", "phone", "--force", "--role", "admin"]],
    [["tokens", "remove"]],
    [["tokens", "list", "extra"]],
  ])("usage error for %j is exit 2", async (args) => {
    const out = await run(args);
    expect(out.code).toBe(2);
    expect(out.err).toContain("Usage: atomic-agent http tokens");
  });

  it("--help prints the roles and exits 0", async () => {
    const out = await run(["--help"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("member  read + chat");
    expect(out.out).toContain("viewer  read");
  });
});
