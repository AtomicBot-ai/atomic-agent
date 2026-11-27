import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../../../approval/approval-gate.js";
import {
  resetResolvedSecretValues,
  resolvedSecretValues,
} from "../../../sandbox/resolved-secret-values.js";
import type { ToolContext } from "../../tool-registry.js";
import {
  hideTypedSecrets,
  hideTypedSecretsText,
  hideValue,
  rememberTypedSecret,
  resetTypedSecrets,
} from "./shell-job-secret.js";
import { compressToolResult, type CompressedToolResult } from "../../../compressor/result-compressor.js";
import { ShellJobRegistry } from "./shell-jobs.js";
import { buildOsShellTool } from "./shell.js";

/**
 * ATO-2486: `{"write": id, "secret": "…"}` asks the person for a value
 * and types it into the job; the model's result never carries it.
 */

const SESSION = "secret-session";
const VALUE = "correct horse 42!";

describe("hideValue", () => {
  it("replaces every occurrence of the value", () => {
    expect(hideValue(`a ${VALUE} b ${VALUE}`, VALUE)).toBe("a [secret hidden] b [secret hidden]");
    expect(hideValue("nothing here", "")).toBe("nothing here");
  });
});

describe("hideTypedSecrets", () => {
  afterEach(() => resetTypedSecrets());

  it("hides a weak typed value in summary, full output and details, only in its session", () => {
    rememberTypedSecret("s1", "letmein");
    const result = compressToolResult({
      tool: "os.shell.run",
      status: "ok",
      output: "Password: letmein\nok",
      details: { tail: "letmein" },
    });
    const hidden = hideTypedSecrets("s1", result);
    expect(hidden.summary).not.toContain("letmein");
    expect(hidden.fullOutput).not.toContain("letmein");
    expect(JSON.stringify(hidden.details)).not.toContain("letmein");
    expect(hideTypedSecrets("s2", result)).toBe(result);
    expect(hideTypedSecretsText("s1", "line: letmein")).toBe("line: [secret hidden]");
    expect(hideTypedSecretsText("s2", "line: letmein")).toBe("line: letmein");
  });

  // Review round 2: the old JSON round trip turned "jobId":1 into
  // "jobId":[secret hidden] and JSON.parse threw on every later call.
  it("never touches numbers, booleans or keys in details, and a short value is not kept session-wide", () => {
    rememberTypedSecret("s", "1");
    const short = { tool: "os.shell.run", status: "ok", summary: "job 1", details: { jobId: 1 }, truncated: false };
    const kept = hideTypedSecrets("s", short as CompressedToolResult);
    expect(kept.details).toEqual({ jobId: 1 });
    expect(kept.summary).toBe("job 1");
    rememberTypedSecret("s", "1234");
    const long = {
      tool: "os.shell.run",
      status: "ok",
      summary: "pin 1234",
      details: { jobId: 1234, ok: true, lines: ["x 1234"], nested: { tail: "1234" } },
      truncated: false,
    };
    const hidden = hideTypedSecrets("s", long as CompressedToolResult);
    expect(hidden.details).toEqual({
      jobId: 1234,
      ok: true,
      lines: ["x [secret hidden]"],
      nested: { tail: "[secret hidden]" },
    });
    expect(hidden.summary).toBe("pin [secret hidden]");
  });

  // Review round 2: the summary is cut before this runs; a tail cut
  // inside the value left its end (`tmein`) behind the marker.
  it("hides the piece of a value a summary cut left behind", () => {
    rememberTypedSecret("s1", "letmein");
    const output = `${"a".repeat(60)} letmein ${"b".repeat(5)}`;
    let found = 0;
    for (let max = 20; max < 90; max += 1) {
      const result = compressToolResult(
        { tool: "os.shell.run", status: "ok", output },
        { maxSummaryLength: max, maxTailLines: 50, overflow: "tail" },
      );
      const after = result.summary.split("… [truncated]\n")[1] ?? "";
      const piece = ["etmein", "tmein", "mein", "ein"].find((p) => after.startsWith(`${p} `));
      if (piece === undefined) continue;
      found += 1;
      const hidden = hideTypedSecrets("s1", result).summary;
      expect(hidden, `cap ${max}`).not.toContain(piece);
      expect(hidden).toContain("[secret hidden]");
    }
    // the loop met cuts inside the value
    expect(found).toBeGreaterThan(0);
  });
});

describe.skipIf(process.platform === "win32")("os.shell.run write secret (ATO-2486)", () => {
  let dir: string;
  let jobs: ShellJobRegistry;
  let asked: ApprovalRequest[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-shell-secret-"));
    jobs = new ShellJobRegistry();
    asked = [];
  });

  afterEach(async () => {
    jobs.endAll();
    resetResolvedSecretValues();
    resetTypedSecrets();
    await rm(dir, { recursive: true, force: true });
  });

  /** A gate that answers the secret request with `answer`, and approves everything else. */
  function tool(answer: Omit<ApprovalDecision, "approvalId">) {
    const gate = new ApprovalGate({
      emit: (req) => {
        asked.push(req);
        if (req.category === "shell_secret_input") {
          gate.resolve({ approvalId: req.approvalId, ...answer });
        } else {
          gate.resolve({ approvalId: req.approvalId, approved: true });
        }
      },
    });
    return buildOsShellTool({
      approvals: gate,
      approvalRequired: true,
      defaultTimeoutMs: 5_000,
      jobs,
      backgroundSettleMs: 300,
    });
  }

  function ctx(): ToolContext {
    return { workingDir: dir, sessionId: SESSION, stepIndex: 0, signal: new AbortController().signal };
  }

  const READS_A_PASSWORD = {
    cmd: "sh",
    args: ["-c", 'printf "Password: "; read -r P; echo "len=${#P} got=$P"; sleep 30'],
    tty: true,
  };

  it("types the person's value into the job; the result shows the reply, never the value", async () => {
    const shell = tool({ approved: true, secret: VALUE });
    const started = await shell.run(READS_A_PASSWORD, ctx());
    expect(started.status).toBe("ok");
    const result = await shell.run({ write: 1, secret: "sudo password", timeoutMs: 5_000 }, ctx());
    expect(result.status).toBe("ok");
    // the program got all 17 characters
    expect(result.summary).toContain("len=17");
    // its echo of the value is hidden from the model
    expect(result.summary).toContain("got=[secret hidden]");
    expect(result.summary).not.toContain(VALUE);
    expect(result.fullOutput ?? "").not.toContain(VALUE);
    expect(JSON.stringify(result.details)).not.toContain(VALUE);
    expect(result.details).toMatchObject({ secret: true, typed: true, jobId: 1 });
    // the request named the job and what it asks for, and no one could grant it for later
    const request = asked.find((req) => req.category === "shell_secret_input");
    expect(request?.secretInput).toMatchObject({ jobId: 1, label: "sudo password" });
    expect(request?.secretInput?.promptLine).toContain("Password:");
    expect(`${request?.reason} ${request?.preview}`).not.toContain(VALUE);
    // masked in every later tool result and trace of this process
    expect(resolvedSecretValues().some((entry) => entry.value === VALUE)).toBe(true);
  });

  // Review: a job that echoes the value and exits inside the reply wait
  // is collected whole; a weak value is not caught by the global masking.
  it("a weak value never shows, when the job echoes it and exits at once, or in a later wait", async () => {
    const shell = tool({ approved: true, secret: "letmein" });
    await shell.run(
      { cmd: "sh", args: ["-c", 'printf "Password: "; read -r P; echo "got=$P"'], tty: true },
      ctx(),
    );
    const result = await shell.run({ write: 1, secret: "password", timeoutMs: 5_000 }, ctx());
    expect(result.summary).not.toContain("letmein");
    expect(result.fullOutput ?? "").not.toContain("letmein");
    expect(JSON.stringify(result.details)).not.toContain("letmein");
    expect(result.summary).toContain("got=[secret hidden]");
    // a later job in the session that prints it is hidden too: in its
    // start result (review round 2) and in a later wait
    const started = await shell.run({ cmd: "sh", args: ["-c", "echo letmein; sleep 30"], tty: true }, ctx());
    expect(started.summary).not.toContain("letmein");
    const later = await shell.run({ wait: 2, timeoutMs: 1_000 }, ctx());
    expect(later.summary).not.toContain("letmein");
    // and in a foreground command's output
    const fg = await shell.run({ cmd: "sh", args: ["-c", "echo letmein"] }, ctx());
    expect(fg.summary).not.toContain("letmein");
  });

  // Review round 2: a value under the session-wide minimum is hidden in
  // the reply to its own write only; this is the write's own guard.
  it("a short value is hidden in its own reply, also when the job exits at once", async () => {
    const shell = tool({ approved: true, secret: "qz7" });
    await shell.run(
      { cmd: "sh", args: ["-c", 'printf "PIN: "; read -r P; echo "got=$P"'], tty: true },
      ctx(),
    );
    const result = await shell.run({ write: 1, secret: "PIN", timeoutMs: 5_000 }, ctx());
    expect(result.summary).not.toContain("qz7");
    expect(result.summary).toContain("got=[secret hidden]");
    // the notice still names the job
    expect(result.summary).toContain("into job 1");
  });

  it("types nothing when the person declines", async () => {
    const shell = tool({ approved: false });
    await shell.run(READS_A_PASSWORD, ctx());
    const result = await shell.run({ write: 1, secret: "sudo password" }, ctx());
    expect(result.status).toBe("ok");
    expect(result.summary).toContain("nothing was typed into job 1: the user declined");
    expect(result.summary).toContain("Do not type sudo password yourself");
    expect(jobs.list(SESSION)[0]?.state).toBe("running");
  });

  it("types nothing when the answer carries no value (a surface that cannot take one)", async () => {
    const shell = tool({ approved: true });
    await shell.run(READS_A_PASSWORD, ctx());
    const result = await shell.run({ write: 1, secret: "sudo password" }, ctx());
    expect(result.summary).toContain("nothing was typed into job 1: no value came with the answer");
    expect(resolvedSecretValues()).toEqual([]);
  });

  it("refuses text together with secret, before anyone is asked", async () => {
    const shell = tool({ approved: true, secret: VALUE });
    await shell.run(READS_A_PASSWORD, ctx());
    const result = await shell.run({ write: 1, secret: "sudo password", text: "hunter2\n" }, ctx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("`secret` replaces `text`");
    expect(asked.some((req) => req.category === "shell_secret_input")).toBe(false);
  });
});
