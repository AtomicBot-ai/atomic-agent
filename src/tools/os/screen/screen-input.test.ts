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
const SETTINGS = { name: "System Settings", bundleId: "com.apple.systempreferences" };
const BROWSERS = [
  ["Safari", "com.apple.Safari"], ["Google Chrome", "com.google.Chrome"], ["Arc", "company.thebrowser.Browser"],
  ["Microsoft Edge", "com.microsoft.edgemac"], ["Firefox", "org.mozilla.firefox"], ["Brave Browser", "com.brave.Browser"],
  ["Opera", "com.operasoftware.Opera"], ["Vivaldi", "com.vivaldi.Vivaldi"], ["Chromium", "org.chromium.Chromium"],
  ["Orion", "com.kagi.kagimacOS"], ["DuckDuckGo", "com.duckduckgo.macos.browser"],
  // Sub-ids: a Chrome web app and a Safari web app (Add to Dock) are the browser too.
  ["Gmail", "com.google.Chrome.app.fmgjjmmmlfnkbppncabfkddbjimcfncm"], ["Web App", "com.apple.Safari.WebApp.1234-ABCD"],
].map(([name, bundleId]) => ({ name: name!, bundleId: bundleId! }));
const CODE_APPS = [
  ["Terminal", "com.apple.Terminal"], ["iTerm2", "com.googlecode.iterm2"], ["Warp", "dev.warp.Warp-Stable"],
  ["Ghostty", "com.mitchellh.ghostty"], ["Visual Studio Code", "com.microsoft.VSCode"], ["Cursor", "com.todesktop.230313mzl4w4u92"],
  ["IntelliJ IDEA", "com.jetbrains.intellij"], ["PyCharm", "com.jetbrains.pycharm"], ["WebStorm", "com.jetbrains.WebStorm"],
].map(([name, bundleId]) => ({ name: name!, bundleId: bundleId! }));
/** An agent started outside any terminal (the desktop's own launch is `io.atomicagent.desktop`, blocked anyway). */
const NO_HOST = { PATH: "/usr/bin" };

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
    // The action script refuses browsers and the blocked apps once more when it posts; terminals take clicks.
    expect(click.protectedIds).toEqual(expect.arrayContaining(["com.apple.Safari", "io.atomicagent.desktop"]));
    expect(click.protectedIds).not.toContain("com.googlecode.iterm2");   // the host Terminal (TERM_PROGRAM) stays in
  });

  it("refuses a click whose point lies on a protected app, at every level and without a prompt", async () => {
    const { order, request, options } = setup({ ownerAtPoint: SETTINGS });
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

describe("browsers are look-only for screen control", () => {
  it("refuses clicks, typing and keys in every known browser, before any prompt, pointing at the browser tool", async () => {
    for (const app of BROWSERS) {
      for (const [tool, args] of [
        [buildOsScreenClickTool, { x: 10, y: 10 }],
        [buildOsScreenTypeTool, { text: "hunter2" }],
        [buildOsScreenKeyTool, { keys: "return" }],
      ] as const) {
        const { order, request, options } = setup({ frontmost: app, ownerAtPoint: app });
        const result = await tool(options).run(args, screenCtx());
        expect(result.status, app.bundleId).toBe("error");
        expect(result.details.reason, app.bundleId).toBe("protected-app");
        expect(result.details.appClass, app.bundleId).toBe("browser");
        expect(result.summary, app.bundleId).toContain("use the browser tool for web pages");
        expect(request, app.bundleId).not.toHaveBeenCalled();
        expect(order, app.bundleId).toEqual(["run:probe"]);
      }
    }
  });

  it("judges the window under the click point, not the frontmost app", async () => {
    // A browser window behind TextEdit, under the point: refused.
    const behind = setup({ frontmost: { name: "TextEdit", bundleId: "com.apple.TextEdit" }, ownerAtPoint: BROWSERS[1] });
    expect((await buildOsScreenClickTool(behind.options).run({ x: 10, y: 10 }, screenCtx())).details.appClass).toBe("browser");
    // A browser in front, but the point is on the Dock: the Dock gets the click.
    const dock = setup({ frontmost: BROWSERS[0], ownerAtPoint: { name: "Dock", bundleId: "com.apple.dock" } });
    expect((await buildOsScreenClickTool(dock.options).run({ x: 10, y: 10 }, screenCtx())).status).toBe("ok");
  });

  it("re-checks at every call: an approved app switched for a browser is refused at the next action", async () => {
    const fake = fakeHost({ frontmost: { name: "TextEdit", bundleId: "com.apple.TextEdit" } });
    const request = vi.fn(async () => ({ approved: true }));
    const options = { approvals: { request } as unknown as ApprovalGate, approvalRequired: true, deps: fake.deps, geometry: new ScreenGeometryStore() };
    expect((await buildOsScreenTypeTool(options).run({ text: "a" }, screenCtx())).status).toBe("ok");
    const switched = setup({ frontmost: BROWSERS[2] });
    const result = await buildOsScreenTypeTool(switched.options).run({ text: "a" }, screenCtx());
    expect(result.details.appClass).toBe("browser");
    expect(switched.request).not.toHaveBeenCalled();
  });

  it("reports the script's own refusal when the app changed between the probe and the action", async () => {
    const { options } = setup({ actionReport: { error: "protected", frontmost: BROWSERS[0] } });
    const result = await buildOsScreenTypeTool(options).run({ text: "a" }, screenCtx());
    expect(result.status).toBe("error");
    expect(result.details.reason).toBe("protected-app");
    expect(result.summary).toContain("Safari");
  });
});

describe("terminals and IDEs take clicks but no typing or keys", () => {
  it("allows a click (with the approval), refuses typing and keys without a prompt, pointing at os.shell.run", async () => {
    for (const app of CODE_APPS) {
      const click = setup({ ownerAtPoint: app, frontmost: app, env: NO_HOST });
      const clicked = await buildOsScreenClickTool(click.options).run({ x: 10, y: 10 }, screenCtx());
      expect(clicked.status, app.bundleId).toBe("ok");
      expect(click.request, app.bundleId).toHaveBeenCalledTimes(1);
      expect(click.fake.ops().at(-1), app.bundleId).toMatchObject({ op: "click", expectBundleId: app.bundleId });
      for (const [tool, args] of [[buildOsScreenTypeTool, { text: "rm -rf ~" }], [buildOsScreenKeyTool, { keys: "return" }]] as const) {
        const { order, request, options } = setup({ frontmost: app, env: NO_HOST });
        const result = await tool(options).run(args, screenCtx());
        expect(result.status, app.bundleId).toBe("error");
        expect(result.details.appClass, app.bundleId).toBe("terminal");
        expect(result.summary, app.bundleId).toContain("use os.shell.run for commands");
        expect(request, app.bundleId).not.toHaveBeenCalled();
        expect(order, app.bundleId).toEqual(["run:probe"]);
      }
    }
  });

  it("the typing and key scripts refuse terminals once more at the moment of posting", async () => {
    const { fake, options } = setup();
    await buildOsScreenTypeTool(options).run({ text: "a" }, screenCtx());
    await buildOsScreenKeyTool(options).run({ keys: "return" }, screenCtx());
    for (const op of fake.ops().filter((o) => o.op !== "probe")) {
      expect(op.protectedIds).toEqual(expect.arrayContaining(["com.apple.Terminal", "com.microsoft.VSCode", "com.apple.Safari"]));
    }
  });

  it("the terminal the agent runs in takes no clicks either (its TUI takes mouse input)", async () => {
    const { request, options } = setup({ ownerAtPoint: TERMINAL, env: { TERM_PROGRAM: "Apple_Terminal" } });
    const result = await buildOsScreenClickTool(options).run({ x: 10, y: 10 }, screenCtx());
    expect(result.details.appClass).toBe("blocked");
    expect(request).not.toHaveBeenCalled();
  });

  it("an unknown app is allowed behind the approval; an unidentified one is refused", async () => {
    const known = setup({ frontmost: { name: "Notes", bundleId: "com.apple.Notes" } });
    expect((await buildOsScreenTypeTool(known.options).run({ text: "a" }, screenCtx())).status).toBe("ok");
    expect(known.request).toHaveBeenCalledTimes(1);
    const nameless = setup({ frontmost: { name: "Mystery", bundleId: null } as unknown as { name: string; bundleId: string } });
    const result = await buildOsScreenTypeTool(nameless.options).run({ text: "a" }, screenCtx());
    expect(result.details.reason).toBe("protected-app");
    expect(nameless.request).not.toHaveBeenCalled();
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
    expect(action.op).toMatchObject({ op: "type", text, typeVia: "keys", expectBundleId: "com.apple.TextEdit" });
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
    expect(fake.ops().at(-1)).toMatchObject({ op: "key", keyCode: 17, flags: 0x100000 | 0x20000, expectBundleId: "com.apple.TextEdit" });
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
