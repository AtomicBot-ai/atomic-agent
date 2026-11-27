import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compressToolResult } from "../../compressor/result-compressor.js";
import { ToolRegistry, type ToolContext } from "../tool-registry.js";
import { confineReads } from "./confine-reads.js";
import { checkGuestRead } from "./guest-reads.js";
import { findStateSecretReads, type StateSecrets } from "./state-secrets.js";

// ATO-2807: `reply.attachments` uploads each file to the Telegram or
// Discord chat. It only checked that the file exists, so a guest or an
// injected instruction could have the agent's `.env` sent as a file.
// The attachments are now checked like reads.
const posix = describe.skipIf(process.platform === "win32");

posix("reply attachments are checked like reads (ATO-2807)", () => {
  let home: string;
  let stateDir: string;
  let work: string;
  let dotenv: string;
  let secrets: StateSecrets;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reply-attachments-"));
    stateDir = join(home, ".atomic-agent");
    work = join(home, "project");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(work, { recursive: true });
    dotenv = join(stateDir, ".env");
    writeFileSync(dotenv, "OPENAI_API_KEY=sk-secret\n");
    writeFileSync(join(work, "report.md"), "# report\n");
    secrets = { stateDir, files: [dotenv] };
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const ctx = (guest = false): ToolContext => ({
    workingDir: work,
    sessionId: "s-reply",
    stepIndex: 0,
    signal: new AbortController().signal,
    ...(guest ? { guest: true } : {}),
  });

  it("asks state_secret for the agent's .env, as an array, a string or with spaces", () => {
    for (const attachments of [[dotenv], dotenv, [`  ${dotenv} `]]) {
      expect(findStateSecretReads("reply", { text: "ok", attachments }, ctx(), secrets)).toEqual([dotenv]);
    }
    expect(findStateSecretReads("reply", { text: "ok", attachments: ["report.md"] }, ctx(), secrets)).toEqual([]);
    expect(findStateSecretReads("reply", { text: "ok" }, ctx(), secrets)).toEqual([]);
  });

  it("refuses a guest's attachment outside the working folder or a .env file", () => {
    const opts = { home, stateDir };
    expect(checkGuestRead("reply", { text: "ok", attachments: [dotenv] }, ctx(true), opts)).not.toBeNull();
    expect(checkGuestRead("reply", { text: "ok", attachments: [join(home, "notes.txt")] }, ctx(true), opts)).not.toBeNull();
    writeFileSync(join(work, ".env"), "TOKEN=x\n");
    expect(checkGuestRead("reply", { text: "ok", attachments: [".env"] }, ctx(true), opts)).not.toBeNull();
    expect(checkGuestRead("reply", { text: "ok", attachments: ["report.md"] }, ctx(true), opts)).toBeNull();
  });

  it("is enforced at dispatch: a guest's reply with the .env never runs", async () => {
    const registry = new ToolRegistry();
    let runs = 0;
    registry.register({
      name: "reply",
      description: "reply",
      readonly: true,
      argsJsonSchema: { type: "object" },
      run: async (args: unknown) => {
        runs += 1;
        return compressToolResult({ tool: "reply", status: "ok", output: JSON.stringify(args) });
      },
    } as unknown as Parameters<ToolRegistry["register"]>[0]);
    confineReads(registry, { grantedDirs: () => [] });
    const sent = await registry.invoke("reply", { text: "ok", attachments: [dotenv] }, ctx(true));
    expect(sent.status).toBe("error");
    expect(runs).toBe(0);
    expect((await registry.invoke("reply", { text: "ok", attachments: ["report.md"] }, ctx(true))).status).toBe("ok");
    expect(runs).toBe(1);
  });
});
