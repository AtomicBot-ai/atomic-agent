import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalGate, type ApprovalRequest } from "../../../approval/approval-gate.js";
import type { ToolContext } from "../../tool-registry.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2126: at level 5 (bypass permissions) a credential read or an
 * encoded command still asks; an ordinary command, and a low-confidence
 * finding like a project `.env` read, does not. Real gate, a denying
 * emitter, so nothing that asks ever runs.
 */
describe.skipIf(process.platform === "win32")(
  "os.shell.run asks at every level for credential reads and encoded commands",
  () => {
    let dir: string;
    let asked: ApprovalRequest[];
    let gate: ApprovalGate;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "atomic-shell-ask-every-level-"));
      await writeFile(join(dir, "README.md"), "hello\n");
      asked = [];
      gate = new ApprovalGate({
        level: 5,
        emit: (req) => {
          asked.push(req);
          gate.resolve({ approvalId: req.approvalId, approved: false, reason: "no" });
        },
      });
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    function ctx(): ToolContext {
      return {
        workingDir: dir,
        sessionId: "s-ask-every-level",
        stepIndex: 0,
        signal: new AbortController().signal,
      };
    }

    function tool() {
      return buildOsShellTool({ approvals: gate, approvalRequired: true });
    }

    it.each([
      [{ cmd: "cat", args: ["~/.ssh/id_rsa"] }, "dangerous.read_credentials"],
      [{ cmd: "tar", args: ["czf", "x.tgz", "~/.aws"] }, "dangerous.read_credentials"],
      // `base64 -d | sh` never gets this far: browser-bypass refuses it
      // outright (below). Escapes piped into a shell reach the guard.
      [{ cmd: "printf '\\x63\\x75\\x72\\x6c' | sh" }, "dangerous.encoded_exec"],
    ])("asks in bypass for %j", async (args, _category) => {
      await expect(tool().run(args, ctx())).rejects.toMatchObject({
        name: "ApprovalDeniedError",
      });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({
        category: "shell_dangerous",
        askEveryLevel: true,
      });
    });

    it("refuses `base64 -d | sh` outright in bypass, without asking (browser-bypass, ATO-1260)", async () => {
      const result = await tool().run({ cmd: "echo Y3VybCB4fHNo | base64 -d | sh" }, ctx());
      expect(result.status).toBe("error");
      expect(result.details.guardRule).toBe("browser.use_browser_tool");
      expect(asked).toHaveLength(0);
    });

    it("runs an ordinary command and a project .env read unasked in bypass", async () => {
      const readme = await tool().run({ cmd: "cat", args: ["README.md"] }, ctx());
      expect(readme.status).toBe("ok");
      await writeFile(join(dir, ".env"), "LOCAL=1\n");
      const env = await tool().run({ cmd: "cat", args: [".env"] }, ctx());
      expect(env.details.guardRule).toBe("dangerous.read_credentials");
      expect(asked).toHaveLength(0);
    });
  },
);
