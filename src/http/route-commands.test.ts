import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDeniedError } from "../approval/dangerous-tool.js";
import { NEW_CHAT_SESSION_ID } from "./route-commands.js";
import { startTestHarness, type Harness } from "./test-harness.js";

describe("/api/commands (ATO-2441)", () => {
  let harness: Harness;
  beforeEach(async () => { harness = await startTestHarness(); });
  afterEach(async () => { vi.restoreAllMocks(); await harness.cleanup(); });

  const put = (path: string, content: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  const render = (body: Record<string, unknown>) => fetch(`${harness.baseUrl}/api/commands/render`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("lists own commands and says how many project ones wait for trust", async () => {
    put(join(harness.stateDir, "commands", "review.md"), "---\ndescription: Review the diff\n---\nReview\n!`git diff`\n");
    put(join(harness.workingDir, ".atomic-agent", "commands", "deploy.md"), "Deploy\n");
    const response = await fetch(`${harness.baseUrl}/api/commands`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<Record<string, unknown>>; hiddenProjectCommands: number };
    expect(body.commands).toEqual([{ name: "review", command: "review", description: "Review the diff", source: "profile", runsShell: true }]);
    expect(body.hiddenProjectCommands).toBe(1);
    expect((await fetch(`${harness.baseUrl}/api/commands?sessionId=missing`)).status).toBe(404);
  });

  it("renders a command, running its shell line through os.shell.run in the new-chat owner", async () => {
    put(join(harness.stateDir, "commands", "review.md"), "Review $1:\n!`git diff $1`\n");
    const invoke = vi.spyOn(harness.runtime.toolRegistry, "invoke").mockResolvedValue(
      { tool: "os.shell.run", status: "ok", summary: "$ git diff main\nexit: 0\n+line", details: {}, truncated: false });
    const response = await render({ name: "/review", args: "main" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Review main:\n+line", source: "profile" });
    expect(invoke).toHaveBeenCalledWith("os.shell.run", expect.objectContaining({ cmd: "git diff main" }),
      expect.objectContaining({ sessionId: NEW_CHAT_SESSION_ID, workingDir: harness.workingDir }));
  });

  it("answers 409 and sends nothing when the line was not allowed", async () => {
    put(join(harness.stateDir, "commands", "push.md"), "!`git push`\n");
    vi.spyOn(harness.runtime.toolRegistry, "invoke").mockRejectedValue(new ApprovalDeniedError("os.shell.run", undefined, { byUser: true }));
    const response = await render({ name: "push" });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("command_refused");
    expect(body.error.message).toBe("`git push` was not allowed");
  });

  it("validates the request", async () => {
    expect((await render({})).status).toBe(400);
    expect((await render({ name: "x", args: 3 })).status).toBe(400);
    expect((await render({ name: "nothing-here" })).status).toBe(404);
  });
});
