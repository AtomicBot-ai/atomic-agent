import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import { ToolRegistry } from "../../tool-registry.js";
import { ScreenGeometryStore } from "./screen-geometry.js";
import {
  buildOsScreenClickTool,
  buildOsScreenKeyTool,
  buildOsScreenTypeTool,
  looksLikeSecret,
  previewText,
} from "./screen-input.js";
import { registerOsScreenTools, OS_SCREEN_TOOL_NAMES } from "./index.js";
import { SCREEN_JXA_SOURCE, SCREEN_PAYLOAD_ENV } from "./screen-jxa.js";
import { fakeHost, screenCtx, type FakeHostOptions } from "./screen-host.fixture.js";

type Decision = { approved: boolean; reason?: string };

function setup(host: FakeHostOptions = {}, decision: Decision = { approved: true }) {
  const fake = fakeHost(host);
  const order: string[] = [];
  const realRun = fake.deps.run;
  fake.deps.run = async (command, args, opts) => {
    const op = opts.env?.[SCREEN_PAYLOAD_ENV];
    order.push(op ? `run:${(JSON.parse(op) as { op: string }).op}` : `run:${command}`);
    return realRun(command, args, opts);
  };
  const request = vi.fn(async (_request: Record<string, unknown>, _options?: unknown) => {
    order.push("approval");
    return decision;
  });
  const approvals = { request } as unknown as ApprovalGate;
  const geometry = new ScreenGeometryStore();
  const options = { approvals, approvalRequired: true, deps: fake.deps, geometry };
  return { fake, order, request, geometry, options };
}

describe("os.screen.click", () => {
  it("asks as screen_control, naming the app and the point, before the click runs", async () => {
    const { fake, order, request, geometry, options } = setup();
    geometry.set("s1", { originX: 0, originY: 0, scale: 1280 / 1440, imageWidth: 1280, imageHeight: 800 });
    const tool = buildOsScreenClickTool(options);
    const result = await tool.run({ x: 640, y: 400 }, screenCtx());
    expect(result.status).toBe("ok");
    expect(order).toEqual(["run:probe", "approval", "run:click"]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "os.screen.click",
        category: "screen_control",
        reason: "left click at 720,450 in Safari (com.apple.Safari)",
        affectedResources: ["app:com.apple.Safari"],
      }),
      expect.anything(),
    );
    const click = fake.ops().find((op) => op.op === "click");
    expect(click).toEqual({ op: "click", x: 720, y: 450, button: "left", double: false, expectBundleId: "com.apple.Safari" });
  });

  it("never clicks when the user declines", async () => {
    const { order, options } = setup({}, { approved: false, reason: "no" });
    const tool = buildOsScreenClickTool(options);
    await expect(tool.run({ x: 10, y: 10 }, screenCtx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(order).toEqual(["run:probe", "approval"]);
  });

  it("refuses without asking when Accessibility is not granted, naming the host app", async () => {
    const { order, request, options } = setup({ accessibility: false });
    const result = await buildOsScreenClickTool(options).run({ x: 1, y: 1 }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("Accessibility");
    expect(result.summary).toContain("Terminal");
    expect(result.details.reason).toBe("accessibility-permission");
    expect(request).not.toHaveBeenCalled();
    expect(order).toEqual(["run:probe"]);
  });

  it("reports, not silently skips, a frontmost app that changed after approval", async () => {
    const { options } = setup({ frontmostAtAction: { name: "Terminal", bundleId: "com.apple.Terminal" } });
    const result = await buildOsScreenClickTool(options).run({ x: 5, y: 5 }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("frontmost app changed");
    expect(result.details.reason).toBe("frontmost-changed");
  });

  it("rejects a point outside the main screen before asking", async () => {
    const { request, options } = setup();
    const result = await buildOsScreenClickTool(options).run({ x: 5000, y: 10 }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("outside the main screen");
    expect(request).not.toHaveBeenCalled();
  });

  it("passes right / double clicks through", async () => {
    const { fake, options } = setup();
    await buildOsScreenClickTool(options).run({ x: 3, y: 4, button: "right", double: true }, screenCtx());
    expect(fake.ops().at(-1)).toMatchObject({ op: "click", x: 3, y: 4, button: "right", double: true });
  });
});

describe("os.screen.type", () => {
  it("sends the text as data in the environment, never in the script source", async () => {
    const { fake, request, options } = setup();
    const text = '"); $.NSTask.launchedTaskWithLaunchPathArguments("/bin/rm", ["-rf"]); ("';
    const result = await buildOsScreenTypeTool(options).run({ text }, screenCtx());
    expect(result.status).toBe("ok");
    const action = fake.calls.at(-1)!;
    expect(action.command).toBe("osascript");
    expect(action.args).toEqual(["-l", "JavaScript", "-e", SCREEN_JXA_SOURCE]);
    expect(action.args.join(" ")).not.toContain("/bin/rm");
    expect(action.op).toEqual({ op: "type", text, expectBundleId: "com.apple.Safari" });
    // The child gets an allow-listed environment, not the agent's secrets.
    expect(Object.keys(action.env ?? {}).sort()).toEqual([SCREEN_PAYLOAD_ENV].sort());
    expect(request.mock.calls[0]?.[0]).toMatchObject({ reason: `type ${text.length} characters in Safari (com.apple.Safari)` });
  });

  it("previews the start of plain text and hides secret-looking text", () => {
    expect(previewText("hello world")).toBe('text (11 chars): "hello world"');
    expect(previewText("a".repeat(50))).toContain("…");
    expect(previewText("sk-abc123def456")).toContain("not shown");
    expect(looksLikeSecret("Tr0ub4dor&3xyzzz")).toBe(true);
    expect(looksLikeSecret("see you at 10")).toBe(false);
  });

  it("rejects empty and over-long text without acting or asking", async () => {
    const { fake, request, options } = setup();
    const tool = buildOsScreenTypeTool(options);
    expect((await tool.run({ text: "" }, screenCtx())).status).toBe("error");
    expect((await tool.run({ text: "x".repeat(2001) }, screenCtx())).status).toBe("error");
    expect(fake.ops().filter((op) => op.op !== "probe")).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("os.screen.key", () => {
  it("parses the chord in TypeScript and posts a key code with flags", async () => {
    const { fake, options } = setup();
    const result = await buildOsScreenKeyTool(options).run({ keys: "Cmd+Shift+T" }, screenCtx());
    expect(result.status).toBe("ok");
    expect(fake.ops().at(-1)).toEqual({ op: "key", keyCode: 17, flags: 0x100000 | 0x20000, expectBundleId: "com.apple.Safari" });
    expect(result.summary).toContain("press shift+cmd+t");
  });

  it("refuses an unknown key without asking", async () => {
    const { request, options } = setup();
    const result = await buildOsScreenKeyTool(options).run({ keys: "hyper+q" }, screenCtx());
    expect(result.status).toBe("error");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("platform and registration", () => {
  it("answers macOS-only on another OS without running anything", async () => {
    const { fake, options } = setup({ platform: "linux" });
    const result = await buildOsScreenTypeTool(options).run({ text: "hi" }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.summary).toContain("ATO-527");
    expect(fake.calls).toEqual([]);
  });

  it("registers the four tools only when enabled on macOS", () => {
    const approvals = new ApprovalGate({ emit: () => undefined });
    const off = new ToolRegistry();
    registerOsScreenTools(off, { approvals, approvalRequired: true, enabled: false, platform: "darwin" });
    expect(off.list()).toEqual([]);
    const linux = new ToolRegistry();
    registerOsScreenTools(linux, { approvals, approvalRequired: true, enabled: true, platform: "linux" });
    expect(linux.list()).toEqual([]);
    const mac = new ToolRegistry();
    registerOsScreenTools(mac, { approvals, approvalRequired: true, enabled: true, platform: "darwin" });
    expect(mac.list().map((tool) => tool.name)).toEqual([...OS_SCREEN_TOOL_NAMES]);
  });
});
