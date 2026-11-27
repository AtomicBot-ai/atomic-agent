import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolContext } from "../../tool-registry.js";
import { buildOsFsArchiveListTool } from "./list-tool.js";
import { buildOsFsArchiveReadEntryTool } from "./read-entry-tool.js";

/**
 * ATO-2805: the guest check at dispatch judged only the archive's path,
 * so a guest's `read_entry {path:"backup.zip", entry:"config/.env"}`
 * returned the file. Secret entries are refused and hidden from `list`
 * for a guest; the owner reads them as before.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "archive-guest-"));
  const zip = new JSZip();
  zip.file("config/.env", "API_KEY=sk-live-guest-must-not-see\n");
  zip.file("deploy/secrets/token.txt", "token guest-must-not-see\n");
  zip.file("Config\\.ENV.local", "X=guest-must-not-see\n");
  zip.file("README.md", "hello from the backup\n");
  await writeFile(join(dir, "backup.zip"), await zip.generateAsync({ type: "nodebuffer" }));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (guest: boolean): ToolContext => ({
  workingDir: dir,
  sessionId: "s",
  stepIndex: 0,
  signal: new AbortController().signal,
  ...(guest ? { guest: true } : {}),
});

describe("os.fs.archive for a guest (ATO-2805)", () => {
  it("refuses a secret entry and still reads an ordinary one", async () => {
    const tool = buildOsFsArchiveReadEntryTool();
    for (const entry of ["config/.env", "./config/.env", "deploy/secrets/token.txt", "Config\\.ENV.local"]) {
      const result = await tool.run({ path: "backup.zip", entry }, ctx(true));
      expect(result.status, entry).toBe("error");
      expect(JSON.stringify(result), entry).not.toContain("guest-must-not-see");
    }
    const ok = await tool.run({ path: "backup.zip", entry: "README.md" }, ctx(true));
    expect(ok.summary).toContain("hello from the backup");
  });

  it("hides secret entry names from a guest's list", async () => {
    const result = await buildOsFsArchiveListTool().run({ path: "backup.zip" }, ctx(true));
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/\.env/i);
    expect(text).not.toContain("secrets/");
    expect(text).toContain("README.md");
  });

  it("lets the owner read and list them", async () => {
    const read = await buildOsFsArchiveReadEntryTool().run({ path: "backup.zip", entry: "config/.env" }, ctx(false));
    expect(read.summary).toContain("sk-live-guest-must-not-see");
    const list = JSON.stringify(await buildOsFsArchiveListTool().run({ path: "backup.zip" }, ctx(false)));
    expect(list).toContain("config/.env");
  });
});
