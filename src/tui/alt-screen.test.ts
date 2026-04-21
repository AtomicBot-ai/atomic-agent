import { describe, expect, it } from "vitest";
import { enterAltScreen } from "./alt-screen.js";

interface FakeStdout {
  isTTY: boolean;
  writes: string[];
  write(chunk: string): boolean;
}

function makeStdout(isTty: boolean): FakeStdout {
  const writes: string[] = [];
  return {
    isTTY: isTty,
    writes,
    write(chunk: string): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

const ENTER = "\u001B[?1049h";
const LEAVE = "\u001B[?1049l";
const HIDE = "\u001B[?25l";
const SHOW = "\u001B[?25h";

describe("enterAltScreen", () => {
  it("writes the enter + hide-cursor sequences on a TTY", () => {
    const stdout = makeStdout(true);
    enterAltScreen({ stdout: stdout as unknown as NodeJS.WriteStream });
    expect(stdout.writes).toEqual([ENTER, HIDE]);
  });

  it("writes the leave + show-cursor sequences on restore", () => {
    const stdout = makeStdout(true);
    const controller = enterAltScreen({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    stdout.writes.length = 0;
    controller.restore();
    expect(stdout.writes).toEqual([SHOW, LEAVE]);
  });

  it("is idempotent — subsequent restores do nothing", () => {
    const stdout = makeStdout(true);
    const controller = enterAltScreen({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.restore();
    stdout.writes.length = 0;
    controller.restore();
    expect(stdout.writes).toEqual([]);
  });

  it("is a no-op on non-TTY streams", () => {
    const stdout = makeStdout(false);
    const controller = enterAltScreen({
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    controller.restore();
    expect(stdout.writes).toEqual([]);
  });

  it("respects hideCursor=false (enter/leave without cursor toggle)", () => {
    const stdout = makeStdout(true);
    const controller = enterAltScreen({
      stdout: stdout as unknown as NodeJS.WriteStream,
      hideCursor: false,
    });
    expect(stdout.writes).toEqual([ENTER]);
    stdout.writes.length = 0;
    controller.restore();
    expect(stdout.writes).toEqual([LEAVE]);
  });
});
