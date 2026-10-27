import { describe, expect, it, vi } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { ApprovalDeniedError } from "../../../approval/dangerous-tool.js";
import { ToolRegistry } from "../../tool-registry.js";
import { ScreenGeometryStore } from "./screen-geometry.js";
import {
  buildOsScreenClickTool,
  buildOsScreenKeyTool,
  buildOsScreenTypeTool,
  previewText,
} from "./screen-input.js";
import { registerOsScreenTools, OS_SCREEN_TOOL_NAMES } from "./index.js";
import { SCREEN_JXA_SOURCE, SCREEN_PAYLOAD_ENV } from "./screen-jxa.js";
import { fakeHost, screenCtx, type FakeHostOptions } from "./screen-host.fixture.js";

type Decision = { approved: boolean; reason?: string };

const TERMINAL = { name: "Terminal", bundleId: "com.apple.Terminal" };

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
  it("hit-tests the point in the probe, names that app in the prompt and pins the click to it", async () => {
    const { fake, order, request, geometry, options } = setup({
      ownerAtPoint: { name: "Finder", bundleId: "com.apple.finder" },
    });
    geometry.set("s1", { originX: 0, originY: 0, scale: 1280 / 1440, imageWidth: 1280, imageHeight: 800 });
    const result = await buildOsScreenClickTool(options).run({ x: 640, y: 400 }, screenCtx());
    expect(result.status).toBe("ok");
    expect(order).toEqual(["run:probe", "approval", "run:click"]);
    expect(fake.ops()[0]).toEqual({ op: "probe", point: { x: 720, y: 450 } });
    expect(request.mock.calls[0]?.[0]).toMatchObject({
      tool: "os.screen.click",
      category: "screen_control",
      reason: "left click at 720,450 in Finder (com.apple.finder)",
      affectedResources: ["app:com.apple.finder"],
    });
    const click = fake.ops()[1]!;
    expect(click).toMatchObject({ op: "click", x: 720, y: 450, button: "left", double: false, expectBundleId: "com.apple.finder" });
    expect(click.protectedIds).toEqual(expect.arrayContaining(["com.apple.Terminal", "io.atomicagent.desktop"]));
  });

  it("refuses a click whose point lies on a protected app, at every level and without a prompt", async () => {
    const { order, request, options } = setup({ ownerAtPoint: TERMINAL });
    const result = await buildOsScreenClickTool(options).run({ x: 10, y: 10 }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("protected-app");
    expect(request).not.toHaveBeenCalled();
    expect(order).toEqual(["run:probe"]);
  });

  it("refuses when nothing identifiable is under the point", async () => {
    const { request, options } = setup({ ownerAtPoint: null });
    const result = await buildOsScreenClickTool(options).run({ x: 10, y: 10 }, screenCtx());
    expect(result.details.reason).toBe("protected-app");
    expect(request).not.toHaveBeenCalled();
  });

  it("never clicks when the user declines", async () => {
    const { order, options } = setup({}, { approved: false, reason: "no" });
    await expect(buildOsScreenClickTool(options).run({ x: 10, y: 10 }, screenCtx())).rejects.toBeInstanceOf(ApprovalDeniedError);
    expect(order).toEqual(["run:probe", "approval"]);
  });

  it("refuses without asking when Accessibility is not granted, naming the host app", async () => {
    const { order, request, options } = setup({ accessibility: false });
    const result = await buildOsScreenClickTool(options).run({ x: 1, y: 1 }, screenCtx());
    expect(result.summary).toContain("Accessibility");
    expect(result.summary).toContain("Terminal");
    expect(result.details.reason).toBe("accessibility-permission");
    expect(request).not.toHaveBeenCalled();
    expect(order).toEqual(["run:probe"]);
  });

  it("reports the script's refusals instead of claiming a click", async () => {
    for (const [error, reason] of [["owner-mismatch", "owner-mismatch"], ["not-frontmost", "not-frontmost"], ["protected", "protected-app"]] as const) {
      const { options } = setup({ actionReport: { error, ownerAtPoint: { name: "Dock", bundleId: "com.apple.dock" } } });
      const result = await buildOsScreenClickTool(options).run({ x: 5, y: 5 }, screenCtx());
      expect(result.status, error).toBe("error");
      expect(result.details.reason, error).toBe(reason);
    }
  });

  it("rejects a point outside the primary display before asking", async () => {
    const { request, options } = setup();
    const result = await buildOsScreenClickTool(options).run({ x: 5000, y: 10 }, screenCtx());
    expect(result.summary).toContain("outside the primary display");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("os.screen.type", () => {
  it("refuses to type into the agent's own terminal — the /mode self-escalation path", async () => {
    const { order, request, options } = setup({ frontmost: TERMINAL });
    const result = await buildOsScreenTypeTool(options).run({ text: "/mode bypass" }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("protected-app");
    expect(request).not.toHaveBeenCalled();
    expect(order).toEqual(["run:probe"]);
  });

  it("refuses the host app named by __CFBundleIdentifier even when it is not on the static list", async () => {
    const host = { name: "Some Shell", bundleId: "com.example.shell" };
    const { request, options } = setup({ frontmost: host, env: { __CFBundleIdentifier: "com.example.shell" } });
    const result = await buildOsScreenTypeTool(options).run({ text: "hi" }, screenCtx());
    expect(result.details.reason).toBe("protected-app");
    expect(request).not.toHaveBeenCalled();
  });

  it("sends the text as data in an allow-listed environment, never in the script source", async () => {
    const { fake, request, options } = setup();
    const text = '"); $.NSTask.launchedTaskWithLaunchPathArguments("/bin/rm", ["-rf"]); ("';
    const result = await buildOsScreenTypeTool(options).run({ text }, screenCtx());
    expect(result.status).toBe("ok");
    const action = fake.calls.at(-1)!;
    expect(action.args).toEqual(["-l", "JavaScript", "-e", SCREEN_JXA_SOURCE]);
    expect(action.args.join(" ")).not.toContain("/bin/rm");
    expect(action.op).toMatchObject({ op: "type", text, typeVia: "keys", expectBundleId: "com.apple.Safari" });
    expect(Object.keys(action.env ?? {}).sort()).toEqual(["PATH", SCREEN_PAYLOAD_ENV].sort());
    expect(String(request.mock.calls[0]?.[0].preview)).toContain(JSON.stringify(text));
  });

  it("shows the whole text in the prompt, secret-looking or long, never truncated", async () => {
    const long = "a".repeat(1990) + "ZZ_END";
    for (const text of ["sk-abc123def456ghi789", long]) {
      const { request, options } = setup();
      await buildOsScreenTypeTool(options).run({ text }, screenCtx());
      const prompt = request.mock.calls[0]![0];
      expect(String(prompt.preview)).toContain(JSON.stringify(text));
      expect(String(prompt.reason)).toContain(JSON.stringify(text));
    }
    expect(previewText("line\nbreak")).toBe('text (10 chars): "line\\nbreak"');
  });

  it("passes the paste route through and rejects unknown ones", async () => {
    const { fake, options } = setup();
    await buildOsScreenTypeTool(options).run({ text: "привет 👋", via: "paste" }, screenCtx());
    expect(fake.ops().at(-1)).toMatchObject({ op: "type", typeVia: "paste" });
    const bad = await buildOsScreenTypeTool(options).run({ text: "x", via: "clipboard" }, screenCtx());
    expect(bad.status).toBe("error");
  });

  it("rejects empty and over-long text without probing or asking", async () => {
    const { fake, request, options } = setup();
    const tool = buildOsScreenTypeTool(options);
    expect((await tool.run({ text: "" }, screenCtx())).status).toBe("error");
    expect((await tool.run({ text: "x".repeat(2001) }, screenCtx())).status).toBe("error");
    expect(fake.calls).toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("os.screen.key", () => {
  it("parses the chord in TypeScript and posts a key code with flags", async () => {
    const { fake, options } = setup();
    const result = await buildOsScreenKeyTool(options).run({ keys: "Cmd+Shift+T" }, screenCtx());
    expect(result.status).toBe("ok");
    expect(fake.ops().at(-1)).toMatchObject({ op: "key", keyCode: 17, flags: 0x100000 | 0x20000, expectBundleId: "com.apple.Safari" });
  });

  it("refuses app and space switchers before probing", async () => {
    for (const keys of ["cmd+tab", "cmd+shift+tab", "cmd+`", "ctrl+left", "cmd+space"]) {
      const { fake, request, options } = setup();
      const result = await buildOsScreenKeyTool(options).run({ keys }, screenCtx());
      expect(result.status, keys).toBe("error");
      expect(result.summary, keys).toContain("refused");
      expect(fake.calls, keys).toEqual([]);
      expect(request, keys).not.toHaveBeenCalled();
    }
  });

  it("refuses a key press into a protected frontmost app", async () => {
    const { request, options } = setup({ frontmost: { name: "System Settings", bundleId: "com.apple.systempreferences" } });
    const result = await buildOsScreenKeyTool(options).run({ keys: "return" }, screenCtx());
    expect(result.details.reason).toBe("protected-app");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("platform and registration", () => {
  it("answers macOS-only on another OS without running anything", async () => {
    const { fake, options } = setup({ platform: "linux" });
    const result = await buildOsScreenTypeTool(options).run({ text: "hi" }, screenCtx());
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
