import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { codingModeLook } from "./coding-mode/coding-mode.js";
import { fakeSession } from "./test-fixtures.js";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";

const SESSION = fakeSession({ workingDir: "/tmp/mode-keys" });

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ESC = "\u001b";

const strip = (value: string): string =>
  value
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\u001b\]8;;[^\u0007]*\u0007/g, "");

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 60));

/**
 * The real app: real stdin, real reducer, real composer. The bug lived
 * between two independent `useInput` subscriptions — the app's key
 * handler drove the menu while the composer still saw the same keys —
 * so nothing below the app shell can show it.
 */
function mount() {
  const submitted: string[] = [];
  const callbacks: TuiAppCallbacks = {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: (text) => {
      submitted.push(text);
    },
  };
  const bus = makeTuiEventBus();
  const app = render(
    <TuiApp session={SESSION} bus={bus} callbacks={callbacks} />,
  );
  return {
    ...app,
    bus,
    submitted,
    frame: () => strip(app.lastFrame() ?? ""),
  };
}

/** Earlier prompts in the input history, as earlier turns leave them. */
function seedHistory(
  bus: ReturnType<typeof makeTuiEventBus>,
  prompts: readonly string[],
): void {
  for (const text of prompts) {
    bus.emitAgentEvent({ type: "user_message", text });
  }
}

async function openModeMenu(app: ReturnType<typeof mount>): Promise<void> {
  app.stdin.write("/mode");
  await settle();
  app.stdin.write("\r");
  await settle();
  // Every row's description is on screen while the menu is up.
  expect(app.frame()).toContain(codingModeLook("plan").detail);
}

describe("keys while the /mode menu is open", () => {
  it("Enter applies the row and sends no prompt, even after ↑", async () => {
    // Reported as: arrows on `/mode` also moved through old prompts, and
    // Enter sent the prompt as well as picking the mode.
    const app = mount();
    await settle();
    seedHistory(app.bus, ["older prompt", "earlier prompt"]);
    await settle();
    await openModeMenu(app);

    app.stdin.write(UP);
    await settle();
    app.stdin.write(UP);
    await settle();
    app.stdin.write("\r");
    await settle();

    // The menu took the Enter and closed …
    expect(app.frame()).not.toContain(codingModeLook("plan").detail);
    // … and the composer did not send what ↑↑ would have recalled.
    expect(app.submitted).toEqual([]);
    app.unmount();
  });

  it("↑ moves the menu, not the input history behind it", async () => {
    const app = mount();
    await settle();
    seedHistory(app.bus, ["earlier prompt"]);
    await settle();
    await openModeMenu(app);

    app.stdin.write(UP);
    await settle();
    // Any other key closes the menu and types through, by design.
    app.stdin.write("x");
    await settle();
    expect(app.frame()).not.toContain(codingModeLook("plan").detail);
    app.stdin.write("\r");
    await settle();

    // Had ↑ reached the composer, the buffer would have held the recalled
    // prompt and this would send "earlier promptx".
    expect(app.submitted).toEqual(["x"]);
    app.unmount();
  });

  it("↓ and Enter stay in the menu too", async () => {
    const app = mount();
    await settle();
    seedHistory(app.bus, ["older prompt", "earlier prompt"]);
    await settle();
    await openModeMenu(app);

    app.stdin.write(DOWN);
    await settle();
    app.stdin.write(DOWN);
    await settle();
    app.stdin.write("\r");
    await settle();

    expect(app.frame()).not.toContain(codingModeLook("plan").detail);
    expect(app.submitted).toEqual([]);
    app.unmount();
  });

  it("Esc only closes the menu; the composer does not open the main menu", async () => {
    const app = mount();
    await settle();
    await openModeMenu(app);

    // A lone Esc is held ~20 ms by Ink; settle() waits past that.
    app.stdin.write(ESC);
    await settle();
    expect(app.frame()).not.toContain(codingModeLook("plan").detail);

    // Had the composer also seen that Esc on an empty box, it would have
    // opened the main menu, and this typing would land there instead of
    // being sent as a prompt.
    app.stdin.write("y");
    await settle();
    app.stdin.write("\r");
    await settle();
    expect(app.submitted).toEqual(["y"]);
    app.unmount();
  });
});
