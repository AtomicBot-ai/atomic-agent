import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createMouseStdin, ESC_SPLIT_FLUSH_MS } from "./mouse-stdin.js";
import type { TuiMouseEvent } from "./mouse-event.js";

/** Long enough for the ESC-split hold to have flushed. */
function sleepPastEscFlush(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, ESC_SPLIT_FLUSH_MS + 20),
  );
}

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
    source.write(`hi${ESC}[A`);
    expect(await collect(stdin)).toBe(`hi${ESC}[A`);
  });

  it("reunites a report whose ESC ended the previous read", async () => {
    // ssh re-chunks the stream, so a flood of reports eventually splits
    // one right after its ESC. Forwarding that ESC immediately used to
    // type `[<0;5;2M` into the composer — the reported coordinate spam.
    const source = makeSource();
    const events: TuiMouseEvent[] = [];
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      (event) => events.push(event),
    );
    source.write(`a${ESC}`);
    source.write("[<0;5;2M");
    expect(await collect(stdin)).toBe("a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "press", x: 4, y: 1 });
  });

  it("still delivers a lone Escape, after the split-hold flush", async () => {
    const source = makeSource();
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
    );
    source.write(ESC);
    expect(await collect(stdin)).toBe("");
    await sleepPastEscFlush();
    expect(await collect(stdin)).toBe(ESC);
  });

  it("trips the leak breaker on a burst of report-shaped text", async () => {
    const source = makeSource();
    let leaks = 0;
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
      { mouseActive: () => true, onMouseTextLeak: () => (leaks += 1) },
    );
    // Reports that lost their ESC somewhere along the way arrive as
    // plain text; two in one read is a misreporting terminal, not a
    // paste.
    source.write("[<0;3;4M[<0;3;5M");
    expect(await collect(stdin)).toBe("");
    expect(leaks).toBe(1);
    // Once tripped it stays tripped and keeps stripping the in-flight
    // stragglers, without firing again.
    source.write(`x[64;9;9My`);
    expect(await collect(stdin)).toBe("xy");
    expect(leaks).toBe(1);
  });

  it("trips the leak breaker on a slow drip of single remnants", async () => {
    // A lossy link stalls mid-report for longer than the ESC-split hold
    // and leaks one report per stall — never two in a chunk. By the
    // third the terminal has proven itself.
    const source = makeSource();
    let leaks = 0;
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
      { mouseActive: () => true, onMouseTextLeak: () => (leaks += 1) },
    );
    source.write("[<0;1;1M");
    source.write("[<0;2;2M");
    source.write("[<0;3;3M");
    // The first two got through before anything was proven; the third
    // trips the breaker and is stripped.
    expect(await collect(stdin)).toBe("[<0;1;1M[<0;2;2M");
    expect(leaks).toBe(1);
  });

  it("counts remnants split across reads toward the trip", async () => {
    // The same re-chunking that leaks a report can split the leaked
    // remnant itself, so no single read ever contains a whole one.
    const source = makeSource();
    let leaks = 0;
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
      { mouseActive: () => true, onMouseTextLeak: () => (leaks += 1) },
    );
    source.write("[<0;1");
    source.write(";1M[<0;2");
    source.write(";2M[<0;3");
    source.write(";3M");
    await collect(stdin);
    expect(leaks).toBe(1);
  });

  it("does not trip on a single report-shaped paste fragment", async () => {
    const source = makeSource();
    let leaks = 0;
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
      { mouseActive: () => true, onMouseTextLeak: () => (leaks += 1) },
    );
    source.write("see [<0;3;4M in the log");
    expect(await collect(stdin)).toBe("see [<0;3;4M in the log");
    expect(leaks).toBe(0);
  });

  it("leaves report-shaped text alone while the mouse is off", async () => {
    const source = makeSource();
    let leaks = 0;
    const { stdin } = createMouseStdin(
      source as unknown as NodeJS.ReadStream,
      () => {},
      { mouseActive: () => false, onMouseTextLeak: () => (leaks += 1) },
    );
    source.write("[<0;3;4M[<0;3;5M");
    expect(await collect(stdin)).toBe("[<0;3;4M[<0;3;5M");
    expect(leaks).toBe(0);
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
