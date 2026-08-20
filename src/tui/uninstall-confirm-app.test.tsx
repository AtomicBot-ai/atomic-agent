import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import { MENU, menuRoots } from "./menu/menu-registry.js";
import { SLASH_COMMANDS, filterSlashCommands } from "./commands/slash-commands.js";

const SESSION = {
  sessionId: "s-1",
  workingDir: "/tmp",
  model: "test-model",
} as unknown as Parameters<typeof TuiApp>[0]["session"];

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*[A-Za-z]/g, "");
}

const tick = () => new Promise((r) => setTimeout(r, 25));

function makeApp() {
  const bus = makeTuiEventBus();
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: vi.fn(),
    onMessageSubmitted: () => {},
  };
  return { ...render(<TuiApp session={SESSION} bus={bus} callbacks={callbacks} />) };
}

describe("uninstall is reachable like every other command", () => {
  it("appears in the slash palette", () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toContain("uninstall");
  });

  it("is fuzzy-searchable by a partial query", () => {
    expect(filterSlashCommands("uninst").map((c) => c.name)).toContain(
      "uninstall",
    );
  });

  it("sits in the Setup group of the operator menu", () => {
    expect(menuRoots("setup").map((n) => n.id)).toContain("setup.uninstall");
  });

  it("carries no chord — a destructive flow must not be one keystroke away", () => {
    const node = MENU.find((n) => n.id === "setup.uninstall");
    expect(node).toBeDefined();
    expect(node?.chord).toBeUndefined();
  });

  it("is an action node that runs through the slash handler", () => {
    const node = MENU.find((n) => n.id === "setup.uninstall");
    expect(node?.kind).toBe("action");
    // Nodes without `slash` are inert when activated — this one must have it,
    // which is also what makes the menu row clickable and keyboard-selectable.
    expect(node?.slash?.name).toBe("uninstall");
  });
});

describe("uninstall confirmation overlay", () => {
  it("opens on /uninstall and states that state is kept by default", async () => {
    const { lastFrame, stdin, unmount } = makeApp();
    await tick();
    stdin.write("/uninstall");
    await tick();
    stdin.write("\r");
    await tick();

    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("uninstall Atomic Agent?");
    expect(frame).toContain("state directory is kept");
    unmount();
  });

  it("n cancels and leaves the agent running", async () => {
    const { lastFrame, stdin, unmount } = makeApp();
    await tick();
    stdin.write("/uninstall");
    await tick();
    stdin.write("\r");
    await tick();
    expect(strip(lastFrame() ?? "")).toContain("uninstall Atomic Agent?");

    stdin.write("n");
    await tick();
    expect(strip(lastFrame() ?? "")).not.toContain("uninstall Atomic Agent?");
    unmount();
  });

  it("s toggles the destructive scope on, with an explicit warning", async () => {
    const { lastFrame, stdin, unmount } = makeApp();
    await tick();
    stdin.write("/uninstall");
    await tick();
    stdin.write("\r");
    await tick();

    stdin.write("s");
    await tick();
    const frame = strip(lastFrame() ?? "");
    expect(frame).toContain("state included");
    expect(frame).toContain("erased for good");
    unmount();
  });

  it("Esc closes the dialog", async () => {
    const { lastFrame, stdin, unmount } = makeApp();
    await tick();
    stdin.write("/uninstall");
    await tick();
    stdin.write("\r");
    await tick();

    stdin.write("");
    await tick();
    expect(strip(lastFrame() ?? "")).not.toContain("uninstall Atomic Agent?");
    unmount();
  });
});
