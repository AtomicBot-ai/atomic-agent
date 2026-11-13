import { describe, expect, it } from "vitest";
import { LogTail, TAIL_MAX_LINES, TAIL_MAX_LINE_CHARS } from "./file-trigger-tail.js";

/** An in-memory file whose reads are recorded. */
function memoryFile(initial = "") {
  const state = { text: initial, reads: [] as Array<[number, number]> };
  return {
    state,
    reader: {
      async readRange(_path: string, start: number, end: number): Promise<Buffer> {
        state.reads.push([start, end]);
        return Buffer.from(state.text, "utf8").subarray(start, end);
      },
    },
    size: () => Buffer.byteLength(state.text, "utf8"),
  };
}

describe("LogTail", () => {
  it("reads only bytes after the seeded size", async () => {
    const file = memoryFile("old ERROR line\n");
    const tail = new LogTail(file.reader);
    tail.seed("/log", file.size());
    file.state.text += "ok\nnew ERROR one\n";
    expect(await tail.readNewMatches("/log", file.size(), "ERROR")).toEqual(["new ERROR one"]);
    expect(file.state.reads).toEqual([[15, file.size()]]);
    expect(await tail.readNewMatches("/log", file.size(), "ERROR")).toEqual([]);
  });

  it("waits for a partial last line to end", async () => {
    const file = memoryFile();
    const tail = new LogTail(file.reader);
    tail.seed("/log", 0);
    file.state.text = "first ERR";
    expect(await tail.readNewMatches("/log", file.size(), "ERR")).toEqual([]);
    file.state.text += "OR done\r\n";
    expect(await tail.readNewMatches("/log", file.size(), "ERROR")).toEqual(["first ERROR done"]);
  });

  it("starts over after truncation or rotation", async () => {
    const file = memoryFile("a long enough first line\n");
    const tail = new LogTail(file.reader);
    tail.seed("/log", file.size());
    file.state.text = "ERROR after rotate\n";
    expect(await tail.readNewMatches("/log", file.size(), "ERROR")).toEqual(["ERROR after rotate"]);
  });

  it("reads a file it never saw from the start", async () => {
    const file = memoryFile("ERROR at birth\n");
    const tail = new LogTail(file.reader);
    expect(await tail.readNewMatches("/new", file.size(), "ERROR")).toEqual(["ERROR at birth"]);
  });

  it("bounds a huge jump to the read cap and drops the cut line", async () => {
    const file = memoryFile();
    const tail = new LogTail(file.reader, 32);
    tail.seed("/log", 0);
    file.state.text = `${"ERROR cut ".repeat(10)}\nERROR kept\n`;
    expect(await tail.readNewMatches("/log", file.size(), "ERROR")).toEqual(["ERROR kept"]);
    expect(file.state.reads[0]).toEqual([file.size() - 32, file.size()]);
  });

  it("caps the number and length of reported lines", async () => {
    const long = `ERROR ${"x".repeat(TAIL_MAX_LINE_CHARS + 50)}`;
    const file = memoryFile(`${Array.from({ length: TAIL_MAX_LINES + 5 }, () => long).join("\n")}\n`);
    const tail = new LogTail(file.reader);
    const lines = await tail.readNewMatches("/log", file.size(), "ERROR");
    expect(lines).toHaveLength(TAIL_MAX_LINES);
    expect(lines[0]).toHaveLength(TAIL_MAX_LINE_CHARS + 1);
  });
});
