import { describe, expect, it } from "vitest";

import { ttyEnv, wrapForTty } from "./tty-wrap.js";

/** ATO-2277: the pty helper per system, and the fallback to pipes. */
describe("wrapForTty", () => {
  const always = () => true;
  const never = () => false;

  it("macOS: script -q /dev/null <program> <args>", () => {
    expect(wrapForTty("/bin/sh", ["-c", "npm init"], "darwin", always)).toEqual({
      command: "/usr/bin/script",
      args: ["-q", "/dev/null", "/bin/sh", "-c", "npm init"],
      tty: true,
    });
  });

  it("Linux: one quoted line for script -c, exit code passed through", () => {
    expect(wrapForTty("python3", ["-c", "print('hi')"], "linux", always)).toEqual({
      command: "/usr/bin/script",
      args: ["-q", "-f", "-e", "-c", "python3 -c 'print('\\''hi'\\'')'", "/dev/null"],
      tty: true,
    });
  });

  it("Windows, or no script on the machine: plain pipes", () => {
    expect(wrapForTty("cmd.exe", ["/c", "x"], "win32", always)).toEqual({
      command: "cmd.exe",
      args: ["/c", "x"],
      tty: false,
    });
    expect(wrapForTty("python3", [], "linux", never).tty).toBe(false);
  });

  it("a pty job gets a plain terminal type and no colours", () => {
    expect(ttyEnv({ PATH: "/bin", TERM: "xterm-256color" })).toEqual({
      PATH: "/bin",
      TERM: "dumb",
      NO_COLOR: "1",
    });
  });
});
