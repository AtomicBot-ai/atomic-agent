import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ToolContext } from "../../tool-registry.js";
import { OutlineCache } from "./code-map-cache.js";
import { buildOsFsCodeMapTool } from "./code-map-tool.js";
import { regexOutlineBackend } from "./regex-outline.js";

/** ATO-2703: a guest's `os.fs.code_map` never outlines a file under `secrets/`. */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "code-map-guest-"));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "secrets"));
  await writeFile(join(dir, "src", "app.ts"), "export function startApp() {}\n");
  await writeFile(join(dir, "src", "credentials.ts"), "export function loadCredentials() {}\n");
  await writeFile(join(dir, "secrets", "vault.ts"), "export function rootPasswordGuestMustNotSee() {}\n");
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
const tool = () => buildOsFsCodeMapTool({ cache: new OutlineCache(), backend: async () => regexOutlineBackend });

describe("os.fs.code_map for a guest (ATO-2703)", () => {
  it("skips secrets/ and keeps ordinary source, credentials.ts included", async () => {
    const text = JSON.stringify(await tool().run({}, ctx(true)));
    expect(text).not.toContain("rootPasswordGuestMustNotSee");
    expect(text).toContain("startApp");
    // Source code named like a credential file is code, not a secret.
    expect(text).toContain("loadCredentials");
  });

  it("outlines everything for the owner", async () => {
    const text = JSON.stringify(await tool().run({}, ctx(false)));
    expect(text).toContain("rootPasswordGuestMustNotSee");
  });
});
