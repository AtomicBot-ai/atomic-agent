import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changedFilesUnder, createMentionServices, protectedPathCheck } from "./mention-services.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "mention-services-")));
  writeFileSync(join(root, ".env"), "OPENAI_API_KEY=sk-test\n");
  writeFileSync(join(root, "a.ts"), "x\n");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("createMentionServices", () => {
  it("never inlines the agent's key file, even inside the working folder", async () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [join(root, ".env")] });
    const now = services.expandNow("look @.env", root);
    expect(now).toContain("not inlined");
    expect(now).not.toContain("sk-test");
    expect(await services.expand("look @.env @diff", root)).not.toContain("sk-test");
  });

  it("never inlines the key file under another letter case (macOS)", async () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [join(root, ".env")] });
    if (process.platform === "darwin") {
      // macOS tmp is case-insensitive: `.ENV` opens `.env`.
      expect(services.expandNow("look @.ENV", root) ?? "").not.toContain("sk-test");
      expect(await services.expand("look @.ENV:1-5 @diff", root)).not.toContain("sk-test");
    }
    expect(protectedPathCheck(["/Users/me/.atomic-agent/.env"], "darwin")("/Users/me/.atomic-agent/.ENV")).toBe(true);
  });

  it("answers at once for plain files and leaves the rest to expand", () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [] });
    expect(services.expandNow("explain @a.ts", root)).toContain('<file path="a.ts">');
    expect(services.expandNow("explain @diff", root)).toBeNull();
  });

  it("reports language servers off without a pool", async () => {
    const services = createMentionServices({ lspPool: () => null, protectedFiles: [] });
    expect(await services.problems(root)).toEqual({ state: "off" });
  });
});

describe("protectedPathCheck", () => {
  it("matches by real path, without case on Windows, and skips code folders", () => {
    const check = protectedPathCheck([join(root, ".env"), `${join(root, "skills")}/`]);
    expect(check(join(root, ".env"))).toBe(true);
    expect(check(join(root, "skills"))).toBe(false);
    expect(protectedPathCheck(["C:\\State\\.env"], "win32")("c:\\state\\.ENV")).toBe(true);
  });
});

describe("sign-in folders (ATO-2496)", () => {
  // The working folder is the state folder: `@auth/chatgpt.json` must not
  // reach the model, though the folder entry ends in a separator.
  it("never inlines a file inside a protected folder", async () => {
    mkdirSync(join(root, "auth"));
    writeFileSync(join(root, "auth", "chatgpt.json"), '{"accessToken":"at-secret"}\n');
    const services = createMentionServices({
      lspPool: () => null,
      protectedFiles: [join(root, ".env"), `${join(root, "auth")}/`],
      protectedFolders: [`${join(root, "auth")}/`],
    });
    expect(services.expandNow("look @auth/chatgpt.json", root)).not.toContain("at-secret");
    expect(await services.expand("look @auth/chatgpt.json:1-1 @diff", root)).not.toContain("at-secret");
  });

  // Review round 2: the check was built once at boot, and a folder that
  // did not exist yet kept its lexical path. With a symlinked state folder
  // and `mcp-oauth/` made after start, the file was inlined.
  it.skipIf(process.platform === "win32")(
    "refuses a folder and a file created after start under a symlinked state folder",
    () => {
      const state = join(root, "state");
      const link = join(root, "state-link");
      mkdirSync(state);
      symlinkSync(state, link);
      const services = createMentionServices({
        lspPool: () => null,
        protectedFiles: [join(link, "http-tokens.json")],
        protectedFolders: [`${join(link, "mcp-oauth")}/`],
      });
      mkdirSync(join(state, "mcp-oauth"));
      writeFileSync(join(state, "mcp-oauth", "x.json"), '{"access_token":"oauth-secret"}\n');
      writeFileSync(join(state, "http-tokens.json"), '{"tokens":["named-secret"]}\n');
      for (const dir of [state, link]) {
        expect(services.expandNow("look @mcp-oauth/x.json", dir) ?? "", dir).not.toContain("oauth-secret");
        expect(services.expandNow("look @http-tokens.json", dir) ?? "", dir).not.toContain("named-secret");
      }
    },
  );

  it("refuses inside the folder only, without case on macOS", () => {
    const check = protectedPathCheck([], "darwin", [`${join(root, "auth")}/`]);
    expect(check(join(root, "AUTH", "copilot.json"))).toBe(true);
    expect(check(join(root, "auth-notes.md"))).toBe(false);
    expect(check(join(root, "a.ts"))).toBe(false);
  });
});

describe("changedFilesUnder", () => {
  it("joins tracked changes and untracked files once each", async () => {
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => ({
      text: args[0] === "diff" ? "a.ts\0b.ts\0" : "b.ts\0new.ts\0",
      cut: false,
    }));
    expect(await changedFilesUnder(git, root)).toEqual(["a.ts", "b.ts", "new.ts"]);
  });

  it("answers nothing outside a checkout", async () => {
    expect(await changedFilesUnder(async () => { throw new Error("not a repo"); }, root)).toEqual([]);
  });
});
