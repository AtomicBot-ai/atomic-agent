import { describe, expect, it, vi } from "vitest";
import { CommandShellRefused, extractShellSlots, fillShellSlots, MAX_SHELL_LINES, MAX_SHELL_OUTPUT_CHARS } from "./command-shell.js";

describe("extractShellSlots (ATO-2441)", () => {
  it("cuts out Claude's !`cmd` and Gemini's !{cmd}, braces nested", () => {
    const { body, slots } = extractShellSlots("Diff:\n!`git diff --stat`\nLog: !{git log -1 --format={%h}}\nEnd", "n");
    expect(slots.map(s => s.command)).toEqual(["git diff --stat", "git log -1 --format={%h}"]);
    expect(body).toBe(`Diff:\n${slots[0]!.marker}\nLog: ${slots[1]!.marker}\nEnd`);
  });

  it("leaves a bare !, an unclosed span, an empty one and one across lines as text", () => {
    const text = "Wow! Run !`ls\nnext` and !{ } and !{open and !`` too";
    expect(extractShellSlots(text, "n")).toEqual({ body: text, slots: [] });
  });

  it("refuses more lines than a template may run", () => {
    const body = Array.from({ length: MAX_SHELL_LINES + 1 }, (_, i) => `!\`echo ${i}\``).join("\n");
    expect(() => extractShellSlots(body)).toThrow(`at most ${MAX_SHELL_LINES} shell lines`);
  });
});

describe("fillShellSlots", () => {
  it("runs each line in order with the arguments filled in and puts the output in its place", async () => {
    const { body, slots } = extractShellSlots("A !`git show $1` B !{wc -l}", "n");
    const run = vi.fn(async (command: string) => `out of ${command}\r\n\n`);
    const text = await fillShellSlots(body, slots, run, line => line.replace("$1", "HEAD"));
    expect(run.mock.calls.map(c => c[0])).toEqual(["git show HEAD", "wc -l"]);
    expect(text).toBe("A out of git show HEAD B out of wc -l");
  });

  it("stops at the first line that is refused: nothing after it runs", async () => {
    const { body, slots } = extractShellSlots("!`git diff` !`rm -rf build`", "n");
    const run = vi.fn(async (command: string) => {
      if (command === "git diff") throw new CommandShellRefused(command, "was not allowed");
      return "ok";
    });
    await expect(fillShellSlots(body, slots, run)).rejects.toThrow("`git diff` was not allowed");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cuts a long output and says so", async () => {
    const { body, slots } = extractShellSlots("!`cat big`", "n");
    const text = await fillShellSlots(body, slots, async () => "x".repeat(MAX_SHELL_OUTPUT_CHARS + 10));
    expect(text.endsWith(`[output cut at ${MAX_SHELL_OUTPUT_CHARS} characters]`)).toBe(true);
  });
});
