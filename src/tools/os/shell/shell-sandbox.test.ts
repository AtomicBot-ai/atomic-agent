import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate } from "../../../approval/approval-gate.js";
import type { OsSandboxSettings } from "../../../sandbox/os-sandbox.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

// ATO-469: with Safe Mode on, the kernel (Seatbelt) keeps a command's
// writes in the working folder and hides the agent's state directory,
// whatever the command line says. Real `sandbox-exec`, so macOS only.
describe.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "os.shell.run inside the Safe Mode sandbox",
  () => {
    let work: string;
    let outside: string;
    let state: string;

    beforeEach(async () => {
      work = await mkdtemp(join(tmpdir(), "atomic-sbx-work-"));
      // Outside every writable root: under the home folder, not temp.
      outside = await mkdtemp(join(homedir(), ".atomic-sbx-outside-"));
      state = await mkdtemp(join(homedir(), ".atomic-sbx-state-"));
      await writeFile(join(state, ".env"), "NOTE=sandbox-marker-469\n");
      // Paths reach the command through variables, so the logical guards
      // (write targets, read scope) cannot see them and only the
      // sandbox can stop the command.
      process.env.ATO469_OUTSIDE = outside;
      process.env.ATO469_STATE = state;
    });

    afterEach(async () => {
      delete process.env.ATO469_OUTSIDE;
      delete process.env.ATO469_STATE;
      for (const dir of [work, outside, state]) {
        await rm(dir, { recursive: true, force: true });
      }
    });

    function ctx(): ToolContext {
      return {
        workingDir: work,
        sessionId: "sbx",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool(settings: OsSandboxSettings) {
      const gate = new ApprovalGate({
        emit: (req) => gate.resolve({ approvalId: req.approvalId, approved: true }),
      });
      return buildOsShellTool({
        approvals: gate,
        approvalRequired: true,
        stateDir: state,
        sandbox: () => settings,
      });
    }

    const on: OsSandboxSettings = { mode: "workspace", network: false };

    it("writes inside the working folder", async () => {
      await tool(on).run({ cmd: "echo inside > inside.txt" }, ctx());
      expect(await readFile(join(work, "inside.txt"), "utf8")).toBe("inside\n");
    });

    it("cannot write outside it", async () => {
      const target = join(outside, "escaped.txt");
      const result = await tool(on).run(
        { cmd: 'echo out > "$ATO469_OUTSIDE/escaped.txt"; echo end' },
        ctx(),
      );
      expect(existsSync(target)).toBe(false);
      expect(result.summary).toContain("end");
      expect(result.summary).toContain("Safe Mode sandbox");
    });

    it("cannot read the agent's .env", async () => {
      const result = await tool(on).run({ cmd: 'cat "$ATO469_STATE/.env"; echo end' }, ctx());
      expect(result.summary).not.toContain("sandbox-marker-469");
      expect(result.summary).toContain("end");
    });

    // Review fix: `cwd` is the model's argument; starting the command in
    // a denied or outside folder must not widen the sandbox to it.
    it("a cwd in the state dir does not reopen it", async () => {
      const result = await tool(on).run(
        { cmd: "cat .env; echo end", cwd: state },
        ctx(),
      );
      expect(result.summary).not.toContain("sandbox-marker-469");
    });

    it("a cwd outside the working folder does not make it writable", async () => {
      await tool(on).run({ cmd: "echo x > escaped.txt", cwd: outside }, ctx());
      expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
    });

    it("runs as before when Safe Mode is off", async () => {
      await mkdir(join(outside, "d"), { recursive: true });
      const target = join(outside, "d", "free.txt");
      await tool({ mode: "off", network: false }).run({ cmd: 'echo free > "$ATO469_OUTSIDE/d/free.txt"' }, ctx());
      expect(existsSync(target)).toBe(true);
    });
  },
);
