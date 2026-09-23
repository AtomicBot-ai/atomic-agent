import { describe, expect, it } from "vitest";

import {
  STREAM_FABRICATION_ABORT_MIN_LINES,
  createFabricatedTranscriptWatcher,
  detectFabricatedToolTranscript,
} from "./fabricated-tool-transcript.js";

const CALL =
  'assistant_tool_call: os.fs.write {"path":"js/scene.js","content":"export const x = 1;"}';
const RESULT = "tool_result[os.fs.write ok]: wrote 20 bytes to js/scene.js";

function transcript(pairs: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < pairs; i += 1) lines.push(CALL, RESULT);
  return lines;
}

/** Feed `text` in `sliceSize` slices; the first verdict the watcher gives, if any. */
function watch(
  text: string,
  sliceSize: number,
  minLines?: number,
): ReturnType<ReturnType<typeof createFabricatedTranscriptWatcher>["push"]> {
  const watcher = createFabricatedTranscriptWatcher(minLines);
  for (let i = 0; i < text.length; i += sliceSize) {
    const verdict = watcher.push(text.slice(i, i + sliceSize));
    if (verdict !== null) return verdict;
  }
  return null;
}

describe("createFabricatedTranscriptWatcher", () => {
  it("acts on the sixth transcript line and not before", () => {
    expect(STREAM_FABRICATION_ABORT_MIN_LINES).toBe(6);
    const six = `${["Writing the scene.", ...transcript(3)].join("\n")}\n`;
    expect(watch(six, 7)).toEqual({ calls: 3, results: 3 });
    const five = `${["Writing the scene.", ...transcript(3).slice(0, 5)].join("\n")}\n`;
    expect(watch(five, 7)).toBeNull();
  });

  it("judges a line only once its newline has arrived", () => {
    const watcher = createFabricatedTranscriptWatcher();
    const lines = transcript(3);
    expect(watcher.push(`${lines.slice(0, 5).join("\n")}\n`)).toBeNull();
    expect(watcher.push(lines[5]!)).toBeNull();
    expect(watcher.push("\n")).toEqual({ calls: 3, results: 3 });
  });

  it.each([1, 3, 17, 64])(
    "reassembles lines split across deltas of %i characters",
    (sliceSize) => {
      // Every transcript line is longer than 64 characters, so no slice
      // here completes two lines: the verdict lands on exactly the sixth.
      const text = `${transcript(4).join("\n")}\n`;
      expect(watch(text, sliceSize)).toEqual({ calls: 3, results: 3 });
    },
  );

  it("judges every complete line a single delta carries", () => {
    // A provider may send many lines in one delta; the verdict counts all
    // of them, which can pass the threshold by more than one.
    const text = `${transcript(4).join("\n")}\n`;
    expect(watch(text, 4_096)).toEqual({ calls: 4, results: 4 });
  });

  it("reads CRLF line endings like the finished-text detector does", () => {
    const text = `${transcript(3).join("\r\n")}\r\n`;
    expect(watch(text, 5)).toEqual({ calls: 3, results: 3 });
  });

  it("ignores a closed code fence that quotes the format", () => {
    const text = `${[
      "History is rendered like this:",
      "```",
      ...transcript(10),
      "```",
      "That is the whole format.",
    ].join("\n")}\n`;
    expect(watch(text, 11)).toBeNull();
  });

  it("does not act on a fence that is still open mid-stream", () => {
    // It may close on the next line and turn out to be a quoted example.
    // The finished-text detector, which sees the end, does count it.
    const text = `${["```", ...transcript(10)].join("\n")}\n`;
    expect(watch(text, 11)).toBeNull();
    expect(detectFabricatedToolTranscript(text)).toEqual({
      calls: 10,
      results: 10,
    });
  });

  it("skips lines inside an inline reasoning block", () => {
    const thinking = `${[
      "<think>",
      "Earlier the history showed:",
      ...transcript(5),
      "</think>",
      "I will call the tool now.",
    ].join("\n")}\n`;
    expect(watch(thinking, 9)).toBeNull();
    const afterThinking = `${thinking}${transcript(3).join("\n")}\n`;
    expect(watch(afterThinking, 9)).toEqual({ calls: 3, results: 3 });
  });

  it("does not trip on long prose that mentions the prefixes", () => {
    const lines: string[] = [];
    for (let i = 0; i < 3_000; i += 1) {
      lines.push(
        i % 2 === 0
          ? `Step ${i}: the \`tool_result[os.fs.read ok]:\` line is how a read is rendered.`
          : `- assistant_tool_call: os.fs.read {"path":"notes-${i}.md"}`,
      );
    }
    const text = `${lines.join("\n")}\n`;
    expect(text.length).toBeGreaterThan(87_228);
    expect(watch(text, 97)).toBeNull();
  });

  it("never counts a line the finished-text detector would not", () => {
    // Every verdict it acts on must hold for the text so far AND any
    // continuation of it — the abort cannot be taken back.
    const shapes = [
      CALL,
      RESULT,
      "```",
      "~~~",
      "Plain prose about the build.",
      "> tool_result[os.fs.read ok]: quoted",
      "tool_call: os.fs.read {}",
      "tool_result[os.shell.run error]: exit 1",
      "",
    ];
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (let doc = 0; doc < 200; doc += 1) {
      const watcher = createFabricatedTranscriptWatcher(2);
      let text = "";
      for (let line = 0; line < 40; line += 1) {
        text += `${shapes[next() % shapes.length]!}\n`;
        const verdict = watcher.push(text.slice(text.lastIndexOf("\n", text.length - 2) + 1));
        if (verdict === null) continue;
        const finished = detectFabricatedToolTranscript(text);
        expect(finished).not.toBeNull();
        expect(verdict.calls).toBeLessThanOrEqual(finished!.calls);
        expect(verdict.results).toBeLessThanOrEqual(finished!.results);
      }
    }
  });
});
