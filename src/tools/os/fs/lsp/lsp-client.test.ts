import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTICS_UNVERSIONED_SETTLE_MS,
  LspConnectionClient,
  uriKey,
} from "./lsp-client.js";
import {
  answerServerRequest,
  createJsonRpcConnection,
  encodeMessage,
  MessageReader,
} from "./lsp-jsonrpc.js";

/**
 * Both ends of a stdio pair: the client's connection, and a scripted
 * server reading what the client sent and writing back.
 */
function wire() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const connection = createJsonRpcConnection(toClient, toServer);
  const received: Array<{ id?: number; method?: string; params?: unknown; result?: unknown }> = [];
  const reader = new MessageReader();
  const listeners: Array<() => void> = [];
  toServer.on("data", (chunk: Buffer) => {
    for (const m of reader.push(chunk)) received.push(m as never);
    for (const l of listeners.splice(0)) l();
  });
  const send = (message: unknown) => toClient.write(encodeMessage(message));
  /** Resolves once the server has received `n` messages in all. */
  const until = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => (received.length >= n ? resolve() : void listeners.push(check));
      check();
    });
  return { connection, received, send, until };
}

const FILE = "/repo/src/a.ts";
const URI = pathToFileURL(FILE).href;

describe("LSP framing (ATO-503)", () => {
  it("splits frames across and within chunks", () => {
    const reader = new MessageReader();
    const a = encodeMessage({ n: 1, text: "héllo" });
    const b = encodeMessage({ n: 2 });
    const all = Buffer.from(a + b, "utf8");
    expect(reader.push(all.subarray(0, 10))).toEqual([]);
    expect(reader.push(all.subarray(10))).toEqual([{ n: 1, text: "héllo" }, { n: 2 }]);
  });

  it("refuses a frame without a length or over the cap", () => {
    expect(() => new MessageReader().push(Buffer.from("X-Foo: 1\r\n\r\n{}"))).toThrow(/Content-Length/);
    expect(() => new MessageReader().push(Buffer.from("Content-Length: 999999999999\r\n\r\n"))).toThrow(/too large/);
  });

  it("answers workspace/configuration with one null per item, anything else with null", () => {
    expect(answerServerRequest("workspace/configuration", { items: [{}, {}] })).toEqual([null, null]);
    expect(answerServerRequest("client/registerCapability", {})).toBeNull();
  });

  it("matches responses to requests and replies to server requests", async () => {
    const { connection, received, send, until } = wire();
    const pending = connection.request("initialize", { x: 1 }, 1000);
    await until(1);
    expect(received[0]).toMatchObject({ id: 1, method: "initialize" });
    send({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    await expect(pending).resolves.toEqual({ capabilities: {} });

    send({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [{}] } });
    await until(2);
    expect(received[1]).toMatchObject({ id: 7, result: [null] });
  });

  it("times a request out and rejects pending ones on dispose", async () => {
    const { connection } = wire();
    await expect(connection.request("slow", null, 5)).rejects.toThrow(/timed out/);
    const hanging = connection.request("hang", null, 10_000);
    connection.dispose("gone");
    await expect(hanging).rejects.toThrow("gone");
  });
});

describe("LspConnectionClient (ATO-503)", () => {
  it("opens the document, then sends full-text changes with rising versions", async () => {
    const { connection, received, send, until } = wire();
    const client = new LspConnectionClient(connection);

    const first = client.diagnose(FILE, "typescript", "let a = 1;", 2000);
    await until(1);
    expect(received[0]).toMatchObject({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: URI, languageId: "typescript", version: 1, text: "let a = 1;" } },
    });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [] } });
    await expect(first).resolves.toEqual([]);

    const second = client.diagnose(FILE, "typescript", "let a: number = 'x';", 2000);
    await until(2);
    expect(received[1]).toMatchObject({
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "let a: number = 'x';" }] },
    });
    const error = { message: "Type 'string' is not assignable to type 'number'.", severity: 1 };
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 2, diagnostics: [error] } });
    await expect(second).resolves.toEqual([error]);
  });

  it("keeps the latest of several publishes and skips stale versions", async () => {
    const { connection, send, until } = wire();
    const client = new LspConnectionClient(connection);
    const open = client.diagnose(FILE, "typescript", "v1", 2000);
    await until(1);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [] } });
    await open;

    const pending = client.diagnose(FILE, "typescript", "v2", 2000);
    await until(2);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [{ message: "stale" }] } });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 2, diagnostics: [{ message: "syntax" }] } });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 2, diagnostics: [{ message: "syntax" }, { message: "types" }] } });
    await expect(pending).resolves.toEqual([{ message: "syntax" }, { message: "types" }]);
  });

  it("answers from the last result when the text did not change", async () => {
    const { connection, received, send, until } = wire();
    const client = new LspConnectionClient(connection);
    const open = client.diagnose(FILE, "typescript", "same", 2000);
    await until(1);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [{ message: "e" }] } });
    await open;
    await expect(client.diagnose(FILE, "typescript", "same", 2000)).resolves.toEqual([{ message: "e" }]);
    expect(received).toHaveLength(1);
  });

  it("gives no verdict when the server stays silent", async () => {
    const { connection } = wire();
    const client = new LspConnectionClient(connection);
    await expect(client.diagnose(FILE, "typescript", "x", 20)).resolves.toBeNull();
  });

  it("is no longer alive once disposed, and disposing tells its owner", async () => {
    const { connection } = wire();
    let owned = true;
    const client = new LspConnectionClient(connection, () => {
      owned = false;
    });
    client.dispose();
    expect(client.alive).toBe(false);
    expect(owned).toBe(false);
    await expect(client.diagnose(FILE, "typescript", "x", 1000)).resolves.toBeNull();
  });
});

describe("LspConnectionClient settle on unversioned publishes (ATO-503)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets stream data and promise callbacks run; setImmediate stays real. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("waits past the empty syntax pass for the TS2322 that follows 800 ms later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { connection, send, until } = wire();
    const client = new LspConnectionClient(connection);

    // "Before" sync: the old text, no errors.
    const before = client.diagnose(FILE, "typescript", "let a: number = 1;", 3000);
    await until(1);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [] } });
    await flush();
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_UNVERSIONED_SETTLE_MS);
    await expect(before).resolves.toEqual([]);

    // "After" sync: syntax-only [] at t=0, the semantic TS2322 at t=800 ms.
    let settled = false;
    const after = client.diagnose(FILE, "typescript", "let a: number = 'x';", 3000);
    void after.then(() => {
      settled = true;
    });
    await until(2);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [] } });
    await flush();
    await vi.advanceTimersByTimeAsync(800);
    expect(settled).toBe(false);
    const ts2322 = {
      message: "Type 'string' is not assignable to type 'number'.",
      severity: 1,
      code: 2322,
      source: "typescript",
    };
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, diagnostics: [ts2322] } });
    await flush();
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_UNVERSIONED_SETTLE_MS);
    await expect(after).resolves.toEqual([ts2322]);
  });

  it("ignores a late versioned publish for the before sync", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { connection, send, until } = wire();
    const client = new LspConnectionClient(connection);
    const before = client.diagnose(FILE, "typescript", "v1", 3000);
    await until(1);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [] } });
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    await expect(before).resolves.toEqual([]);

    const after = client.diagnose(FILE, "typescript", "v2", 3000);
    await until(2);
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 2, diagnostics: [{ message: "new" }] } });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: URI, version: 1, diagnostics: [] } });
    await flush();
    await vi.advanceTimersByTimeAsync(400);
    await expect(after).resolves.toEqual([{ message: "new" }]);
  });
});

describe("uriKey", () => {
  it("compares Windows URIs decoded and without case", () => {
    expect(uriKey("file:///c%3A/Repo/a.ts", "win32")).toBe(uriKey("file:///C:/Repo/a.ts", "win32"));
    expect(uriKey("file:///repo/My%20File.ts", "darwin")).toBe("file:///repo/My File.ts");
  });
});
