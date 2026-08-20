import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMouseStdin } from "./mouse-stdin.js";
import type { TuiMouseEvent } from "./mouse-event.js";

const ESC = "\u001B";

interface FakeTty extends PassThrough {
  isTTY?: boolean;
  rawModeCalls?: boolean[];
}

function makeSource(): FakeTty {
  const stream = new PassThrough() as FakeTty;
  stream.isTTY = true;
  stream.rawModeCalls = [];
  (stream as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (
    mode: boolean,
  ) => {
    stream.rawModeCalls?.push(mode);
  };
  return stream;
}

async function collect(stream: NodeJS.ReadStream): Promise<string> {
  await new Promise((resolve) => setImmediate(resolve));
  const chunks: string[] = [];
  let chunk: unknown;
  while ((chunk = stream.read()) !== null) {
    chunks.push(String(chunk));
  }
  return chunks.join("");
}

describe("createMouseStdin", () => {
  it("keeps mouse reports away from the keyboard stream", async () => {
    const source = makeSource();
    const events: TuiMouseEvent[] = [];
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      (event) => events.push(event),
    );
    source.write(`a${ESC}[<0;5;2Mb`);
    expect(await collect(stdin)).toBe("ab");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "press", x: 4, y: 1 });
  });

  it("reassembles a report split across two reads", async () => {
    const source = makeSource();
    const events: TuiMouseEvent[] = [];
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      (event) => events.push(event),
    );
    source.write(`${ESC}[<64;3`);
    source.write(";9M");
    expect(await collect(stdin)).toBe("");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "wheel", wheel: "up", y: 8 });
  });

  it("forwards ordinary keystrokes untouched", async () => {
    const source = makeSource();
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
    );
    source.write(`hi${ESC}[A${ESC}`);
    expect(await collect(stdin)).toBe(`hi${ESC}[A${ESC}`);
  });

  it("proxies TTY-ness and raw mode to the real stdin", () => {
    const source = makeSource();
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
    );
    expect(stdin.isTTY).toBe(true);
    stdin.setRawMode(true);
    expect(source.rawModeCalls).toEqual([true]);
  });

  it("stops listening after dispose", async () => {
    const source = makeSource();
    const events: TuiMouseEvent[] = [];
    const { stdin, dispose } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      (event) => events.push(event),
    );
    dispose();
    source.write(`x${ESC}[<0;1;1M`);
    expect(await collect(stdin)).toBe("");
    expect(events).toEqual([]);
  });
});
