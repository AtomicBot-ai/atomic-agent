import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ReactElement, ReactNode } from "react";
import type { TuiMouseEvent } from "../mouse/mouse-event.js";
import { MouseProvider } from "../mouse/mouse-context.js";
import { MouseTargetRegistry } from "../mouse/mouse-registry.js";
import type { TuiAppCallbacks } from "../tui-app.js";
import { createInitialTuiState, type TuiSessionInfo } from "../tui-state.js";
import {
  ChatLinkButtons,
  extractMessageUrls,
  linkChipLabel,
} from "./chat-link-buttons.js";

const SESSION: TuiSessionInfo = {
  sessionId: "links",
  workingDir: "/tmp/links",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

function strip(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

/** Screen position of `needle` — same trick as `chat-copy-button.test.tsx`. */
function locate(frame: string, needle: string): { x: number; y: number } {
  for (const [y, line] of frame.split("\n").entries()) {
    const x = line.indexOf(needle);
    if (x !== -1) return { x, y };
  }
  throw new Error(`"${needle}" is not on screen:\n${frame}`);
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    kind: "press",
    button: "left",
    wheel: null,
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Harness {
  frame: () => string;
  clickAt: (needle: string) => void;
  unmount: () => void;
}

function callbacksWith(opened: string[]): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
    onOpenUrlRequested: (url) => opened.push(url),
  };
}

function mount(
  children: ReactNode,
  {
    withMouse = true,
    opened = [],
  }: { withMouse?: boolean; opened?: string[] } = {},
): Harness {
  const registry = new MouseTargetRegistry();
  const state = createInitialTuiState(SESSION);
  const tree: ReactElement = withMouse ? (
    <MouseProvider
      registry={registry}
      dispatch={() => {}}
      callbacks={callbacksWith(opened)}
      getState={() => state}
    >
      {children}
    </MouseProvider>
  ) : (
    <>{children}</>
  );
  const { lastFrame, unmount } = render(tree);
  const frame = (): string => strip(lastFrame() ?? "");
  return {
    frame,
    clickAt: (needle) => {
      const at = locate(frame(), needle);
      registry.dispatch(click(at.x, at.y));
    },
    unmount,
  };
}

/**
 * Clicks the chip until the click actually lands — the target is
 * registered by a post-frame effect, exactly as in
 * `chat-copy-button.test.tsx`.
 */
async function clickChip(
  app: Harness,
  needle: string,
  opened: readonly string[],
): Promise<void> {
  await waitUntil(() => app.frame().includes(needle), "the idle chip");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (opened.length > 0) return;
    app.clickAt(needle);
    await delay(25);
  }
  throw new Error("click never took effect on the link chip");
}

describe("extractMessageUrls", () => {
  it("collects normalised targets in message order", () => {
    expect(
      extractMessageUrls("see https://a.io then www.b.io for details"),
    ).toEqual(["https://a.io", "https://www.b.io"]);
  });

  it("dedupes on the normalised target", () => {
    expect(
      extractMessageUrls("https://a.io twice https://a.io"),
    ).toEqual(["https://a.io"]);
  });

  it("is empty for a message without URLs", () => {
    expect(extractMessageUrls("no links in here")).toEqual([]);
  });
});

describe("linkChipLabel", () => {
  it("labels with the bare hostname, www shorn", () => {
    expect(linkChipLabel("https://www.example.com/deep/path?q=1")).toBe(
      "example.com",
    );
  });

  it("ellipsises an overlong hostname", () => {
    const label = linkChipLabel(
      "https://an.absurdly.long.subdomain.chain.example-hosting.io/x",
    );
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(24);
  });
});

describe("ChatLinkButtons", () => {
  it("renders one chip per URL, labelled by hostname", () => {
    const app = mount(
      <ChatLinkButtons text="docs at https://cursor.com and www.example.com" />,
    );
    expect(app.frame()).toContain("[open cursor.com]");
    expect(app.frame()).toContain("[open example.com]");
    app.unmount();
  });

  it("renders nothing for a message without URLs", () => {
    const app = mount(<ChatLinkButtons text="just prose" />);
    expect(app.frame()).not.toContain("[open");
    app.unmount();
  });

  it("renders a single chip for a repeated URL", () => {
    const app = mount(
      <ChatLinkButtons text="https://a.io and again https://a.io" />,
    );
    expect(app.frame().split("[open a.io]").length).toBe(2);
    app.unmount();
  });

  it("caps at three chips and notes the overflow", () => {
    const app = mount(
      <ChatLinkButtons text="https://a.io https://b.io https://c.io https://d.io https://e.io" />,
    );
    const frame = app.frame();
    expect(frame).toContain("[open a.io]");
    expect(frame).toContain("[open c.io]");
    expect(frame).not.toContain("[open d.io]");
    expect(frame).toContain("+2 more");
    app.unmount();
  });

  it("still renders without a mouse provider", () => {
    const app = mount(<ChatLinkButtons text="see https://cursor.com" />, {
      withMouse: false,
    });
    expect(app.frame()).toContain("[open cursor.com]");
    app.unmount();
  });

  it("fires the callback with the normalised https URL and badges", async () => {
    const opened: string[] = [];
    const app = mount(<ChatLinkButtons text="try www.example.com now" />, {
      opened,
    });
    await clickChip(app, "[open example.com]", opened);
    expect(opened).toEqual(["https://www.example.com"]);
    await waitUntil(
      () => app.frame().includes("[opening…]"),
      "the opening badge",
    );
    app.unmount();
  });

  it("opens the URL its own chip names, not a neighbour's", async () => {
    const opened: string[] = [];
    const app = mount(
      <ChatLinkButtons text="https://a.io then https://b.io" />,
      { opened },
    );
    await clickChip(app, "[open b.io]", opened);
    expect(opened).toEqual(["https://b.io"]);
    app.unmount();
  });
});
