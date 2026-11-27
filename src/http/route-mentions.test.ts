import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MentionServices } from "../mentions/index.js";
import { startTestHarness, type Harness } from "./test-harness.js";

// ATO-2472: the desktop's `@` mentions and `@problems` go through these routes.
describe("/api/mentions/expand and /api/problems", () => {
  let harness: Harness;
  let folder: string;

  beforeEach(async () => {
    harness = await startTestHarness();
    folder = realpathSync(mkdtempSync(join(tmpdir(), "atomic-http-mentions-")));
    writeFileSync(join(folder, "a.ts"), "export const a = 1;\n");
  });

  afterEach(async () => {
    await harness.cleanup();
    rmSync(folder, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`${harness.baseUrl}/api/mentions/expand`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("expands the mentions with the runtime's shared services, in the folder given", async () => {
    const res = await post({ text: "explain @a.ts", workingDir: folder });
    expect(res.status).toBe(200);
    const { text } = (await res.json()) as { text: string };
    expect(text).toContain('<file path="a.ts">\nexport const a = 1;\n</file>');
  });

  it("refuses a relative folder and a missing text", async () => {
    expect((await post({ text: "x", workingDir: "relative/dir" })).status).toBe(400);
    expect((await post({ workingDir: folder })).status).toBe(400);
  });

  it("answers 404 for an unknown session", async () => {
    expect((await post({ text: "x", sessionId: "no-such-session" })).status).toBe(404);
  });

  it("reports the problems state and its plain text", async () => {
    const problems = vi.fn(async () => ({ state: "no_server" as const }));
    const fake: MentionServices = { expand: async (t) => t, expandNow: () => null, problems };
    (harness.runtime as { mentions?: MentionServices }).mentions = fake;
    const res = await fetch(`${harness.baseUrl}/api/problems?workingDir=${encodeURIComponent(folder)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; text: string };
    expect(body.state).toBe("no_server");
    expect(body.text).toContain("No language server is running for this folder.");
    expect(problems).toHaveBeenCalledWith(folder);
  });

  it("answers 501 without mention services", async () => {
    (harness.runtime as { mentions?: MentionServices }).mentions = undefined;
    expect((await post({ text: "x" })).status).toBe(501);
  });
});
