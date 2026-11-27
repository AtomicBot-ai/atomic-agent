import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolContext } from "../../tool-registry.js";
import { osFsGlobTool } from "./fs-glob.js";

/** ATO-2703: a guest's recursive glob never lists a nested `.env`, key or `secrets/` file. */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fs-glob-guest-"));
  for (const dir of ["config", "src", "deploy/secrets", "keys"]) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, "config", ".env"), "API_KEY=x\n");
  await writeFile(join(root, "config", ".env.local"), "API_KEY=y\n");
  await writeFile(join(root, "deploy", "secrets", "token.txt"), "t\n");
  await writeFile(join(root, "keys", "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  await writeFile(join(root, "src", "app.ts"), "export {};\n");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (guest: boolean): ToolContext => ({
  workingDir: root,
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});

const listed = async (guest: boolean): Promise<string[]> => {
  const result = await osFsGlobTool.run({ pattern: "**/*" }, ctx(guest));
  return (result.details as { files: string[] }).files;
};

describe("os.fs.glob for a guest (ATO-2703)", () => {
  it("lists ordinary files but none of the secret ones", async () => {
    const files = await listed(true);
    expect(files).toEqual(["src/app.ts"]);
  });

  it("still lists everything for the owner", async () => {
    const files = await listed(false);
    expect(files).toEqual(expect.arrayContaining(["config/.env", "config/.env.local", "deploy/secrets/token.txt", "keys/server.pem", "src/app.ts"]));
  });
});
