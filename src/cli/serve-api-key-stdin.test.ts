import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { givenServeApiKey, MAX_KEY_BYTES, readKeyLine } from "./serve-api-key-stdin.js";
import { parseArgs, type ServeArgs } from "./serve-args.js";

function parsedOk(args: string[]): ServeArgs {
  const parsed = parseArgs(args);
  if ("help" in parsed || "error" in parsed) throw new Error(`expected a parse, got ${JSON.stringify(parsed)}`);
  return parsed;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("readKeyLine (ATO-2538)", () => {
  it("takes the first line, without its line ending, and leaves the rest unread", async () => {
    const stdin = new PassThrough();
    const read = readKeyLine(stdin, 1_000);
    stdin.write("0f1e2d3c4b5a6978\r\nnot-a-key\n");
    await expect(read).resolves.toEqual({ key: "0f1e2d3c4b5a6978" });
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("takes a key that ends at EOF without a newline", async () => {
    const stdin = new PassThrough();
    const read = readKeyLine(stdin, 1_000);
    stdin.end("abc-key");
    await expect(read).resolves.toEqual({ key: "abc-key" });
  });

  it("refuses an empty first line, an endless line and a silent spawner", async () => {
    const empty = new PassThrough();
    const a = readKeyLine(empty, 1_000);
    empty.end("\n");
    expect(await a).toHaveProperty("error");

    const endless = new PassThrough();
    const b = readKeyLine(endless, 1_000);
    endless.write("k".repeat(MAX_KEY_BYTES + 1));
    expect(await b).toHaveProperty("error");

    const silent = new PassThrough();
    expect(await readKeyLine(silent, 20)).toHaveProperty("error");
  });
});

describe("serve --api-key-stdin (ATO-2538)", () => {
  it("takes the key from stdin, never from ATOMIC_AGENT_API_KEY", async () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "key-from-the-environment");
    const parsed = parsedOk(["--api-key-stdin"]);
    expect(parsed.apiKeyStdin).toBe(true);
    expect(parsed.apiKey).toBeNull();
    const stdin = new PassThrough();
    const given = givenServeApiKey(parsed, stdin, 1_000);
    stdin.end("key-from-stdin-0123456789\n");
    await expect(given).resolves.toEqual({ key: "key-from-stdin-0123456789" });
  });

  it("without the flag, stdin is not read", async () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "");
    const stdin = new PassThrough();
    await expect(givenServeApiKey(parsedOk(["--api-key", "flag-key"]), stdin, 1_000)).resolves.toEqual({ key: "flag-key" });
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it("holds a stdin key to the same rules as --api-key", async () => {
    const short = new PassThrough();
    const onNetwork = givenServeApiKey(parsedOk(["--api-key-stdin", "--host", "0.0.0.0"]), short, 1_000);
    short.end("short\n");
    expect(await onNetwork).toHaveProperty("error");

    const blank = new PassThrough();
    const spaces = givenServeApiKey(parsedOk(["--api-key-stdin"]), blank, 1_000);
    blank.end("   \n");
    expect(await spaces).toHaveProperty("error");
  });

  it("refuses --api-key together with --api-key-stdin", () => {
    expect(parseArgs(["--api-key", "x", "--api-key-stdin"])).toHaveProperty("error");
  });

  it("parses on a network host and with --a2a, whose key checks wait for stdin", () => {
    vi.stubEnv("ATOMIC_AGENT_API_KEY", "");
    expect(parsedOk(["--api-key-stdin", "--host", "0.0.0.0"]).host).toBe("0.0.0.0");
    expect(parsedOk(["--api-key-stdin", "--a2a"]).a2a).toBe(true);
  });
});
