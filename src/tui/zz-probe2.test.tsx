import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";
import { describe, it } from "vitest";
import { makeTuiEventBus, TuiApp, type TuiAppCallbacks } from "./tui-app.js";
import type { TuiSessionInfo } from "./tui-state.js";

const SESSION: TuiSessionInfo = {
  sessionId: "s1",
  workingDir: "/tmp/smoke",
  llamaUrl: "http://127.0.0.1:8080",
  browserChannel: "chrome",
  browserHeadless: false,
  approvalLevel: 5,
  maxSteps: 10,
  skillCount: 0,
};

class Out extends EventEmitter {
  frames: string[] = [];
  last = "";
  isTTY = true;
  columns: number;
  rows: number;
  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write = (f: string): void => {
    this.frames.push(f);
    this.last = f;
  };
}
class In extends EventEmitter {
  isTTY = true;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): null {
    return null;
  }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR = new RegExp(ESC + "\\[[0-9;]*m", "g");
const OSC8 = new RegExp(ESC + "\\]8;;[^" + BEL + "]*" + BEL, "g");
const strip = (v: string): string => v.replace(SGR, "").replace(OSC8, "");
const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 200));

function cb(): TuiAppCallbacks {
  return {
    onApprovalDecision: () => {},
    onAbort: () => {},
    onQuit: () => {},
    onMessageSubmitted: () => {},
  };
}

async function dump(
  label: string,
  columns: number,
  rows: number,
  setup?: (bus: ReturnType<typeof makeTuiEventBus>) => void,
): Promise<void> {
  const stdout = new Out(columns, rows);
  const stderr = new Out(columns, rows);
  const stdin = new In();
  const bus = makeTuiEventBus();
  const inst = render(<TuiApp session={SESSION} bus={bus} callbacks={cb()} />, {
    stdout: stdout as never,
    stderr: stderr as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await settle();
  if (setup) {
    setup(bus);
    await settle();
  }
  const lines = strip(stdout.last).replace(/\n$/, "").split("\n");
  // eslint-disable-next-line no-console
  console.log(`===== ${label} (${columns}x${rows}) rows=${lines.length}`);
  lines.forEach((l, i) => {
    // eslint-disable-next-line no-console
    console.log(String(i + 1).padStart(3, " ") + "|" + l);
  });
  inst.unmount();
}

describe("frame dump", () => {
  it("llm tab", async () => {
    await dump("debug/llm", 100, 24, (bus) => {
      bus.emit({ type: "ui_mode_set", mode: "debug" });
      bus.emit({ type: "tab_changed", tab: "llm" as never });
    });
  }, 120000);
});
