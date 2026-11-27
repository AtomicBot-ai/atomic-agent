import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { LspConnectionClient } from "./lsp-client.js";
import { createJsonRpcConnection, encodeMessage, MessageReader } from "./lsp-jsonrpc.js";
import { navigate, parseHover, parseLocations, parseSymbols } from "./lsp-navigation.js";

/** A scripted server on the other end of a stdio pair (as in lsp-client.test). */
function wire() {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const connection = createJsonRpcConnection(toClient, toServer);
  const received: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  const reader = new MessageReader();
  const listeners: Array<() => void> = [];
  toServer.on("data", (chunk: Buffer) => {
    for (const m of reader.push(chunk)) received.push(m as never);
    for (const l of listeners.splice(0)) l();
  });
  const send = (message: unknown) => toClient.write(encodeMessage(message));
  const until = (n: number) =>
    new Promise<void>((resolve) => {
      const check = () => (received.length >= n ? resolve() : void listeners.push(check));
      check();
    });
  return { client: new LspConnectionClient(connection), received, send, until };
}

const FILE = "/repo/src/a.ts";
const URI = pathToFileURL(FILE).href;
const OTHER = "/repo/src/b.ts";
const OTHER_URI = pathToFileURL(OTHER).href;
const range = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 3 },
});

describe("navigate over a live connection (ATO-2373)", () => {
  it("opens the file, sends textDocument/definition at the 0-based position and reads LocationLinks", async () => {
    const { client, received, send, until } = wire();
    const pending = navigate(
      client,
      { action: "definition", absolute: FILE, languageId: "typescript", text: "foo();\n", line: 0, character: 1 },
      2000,
    );
    await until(2);
    expect(received[0]).toMatchObject({
      method: "textDocument/didOpen",
      params: { textDocument: { uri: URI, languageId: "typescript", version: 1, text: "foo();\n" } },
    });
    expect(received[1]).toMatchObject({
      method: "textDocument/definition",
      params: { textDocument: { uri: URI }, position: { line: 0, character: 1 } },
    });
    send({
      jsonrpc: "2.0",
      id: received[1]!.id,
      result: [{ targetUri: OTHER_URI, targetRange: range(9, 0), targetSelectionRange: range(9, 16) }],
    });
    await expect(pending).resolves.toEqual({
      kind: "hits",
      hits: [{ path: OTHER, uri: OTHER_URI, line: 10, col: 17 }],
    });
  });

  it("asks references with the declaration included, and does not reopen an unchanged file", async () => {
    const { client, received, send, until } = wire();
    client.sync(FILE, "typescript", "foo();\n");
    const pending = navigate(
      client,
      { action: "references", absolute: FILE, languageId: "typescript", text: "foo();\n", line: 0, character: 0 },
      2000,
    );
    await until(2);
    expect(received.map((m) => m.method)).toEqual(["textDocument/didOpen", "textDocument/references"]);
    expect(received[1]!.params).toMatchObject({ context: { includeDeclaration: true } });
    send({
      jsonrpc: "2.0",
      id: received[1]!.id,
      result: [
        { uri: URI, range: range(0, 0) },
        { uri: OTHER_URI, range: range(4, 2) },
      ],
    });
    const answer = await pending;
    expect(answer.kind === "hits" ? answer.hits.map((h) => `${h.path}:${h.line}:${h.col}`) : []).toEqual([
      `${FILE}:1:1`,
      `${OTHER}:5:3`,
    ]);
  });

  it("sends a full-text change with a new version when the file changed since the last sync", async () => {
    const { client, received, send, until } = wire();
    client.sync(FILE, "typescript", "v1");
    const pending = navigate(
      client,
      { action: "hover", absolute: FILE, languageId: "typescript", text: "v2", line: 0, character: 0 },
      2000,
    );
    await until(3);
    expect(received[1]).toMatchObject({
      method: "textDocument/didChange",
      params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: "v2" }] },
    });
    expect(received[2]!.method).toBe("textDocument/hover");
    send({ jsonrpc: "2.0", id: received[2]!.id, result: { contents: { kind: "markdown", value: "const v2: number" } } });
    await expect(pending).resolves.toEqual({ kind: "hover", text: "const v2: number" });
  });

  it("uses workspace/symbol with a query and textDocument/documentSymbol without one", async () => {
    const { client, received, send, until } = wire();
    const base = { action: "symbols" as const, absolute: FILE, languageId: "typescript", text: "x", line: 0, character: 0 };
    const search = navigate(client, { ...base, query: "Foo" }, 2000);
    await until(2);
    expect(received[1]).toMatchObject({ method: "workspace/symbol", params: { query: "Foo" } });
    send({ jsonrpc: "2.0", id: received[1]!.id, result: [] });
    await search;
    const outline = navigate(client, base, 2000);
    await until(3);
    expect(received[2]).toMatchObject({ method: "textDocument/documentSymbol", params: { textDocument: { uri: URI } } });
    send({ jsonrpc: "2.0", id: received[2]!.id, result: null });
    await expect(outline).resolves.toEqual({ kind: "hits", hits: [] });
  });

  it("refuses a client without navigation support instead of hanging", async () => {
    const fake = { alive: true, diagnose: async () => [], dispose: () => {} };
    await expect(
      navigate(fake, { action: "definition", absolute: FILE, languageId: "typescript", text: "", line: 0, character: 0 }, 10),
    ).rejects.toThrow(/cannot answer navigation/);
  });
});

describe("LSP answer parsing (ATO-2373)", () => {
  it("reads a single Location, a Location list, LocationLinks and null", () => {
    expect(parseLocations({ uri: URI, range: range(2, 4) })).toEqual([{ path: FILE, uri: URI, line: 3, col: 5 }]);
    expect(parseLocations([{ uri: URI, range: range(0, 0) }, { junk: true }])).toHaveLength(1);
    expect(parseLocations([{ targetUri: URI, targetRange: range(7, 0) }])).toEqual([
      { path: FILE, uri: URI, line: 8, col: 1 },
    ]);
    expect(parseLocations(null)).toEqual([]);
  });

  it("keeps a non-file URI as such, without a path", () => {
    expect(parseLocations([{ uri: "jdt://contents/rt.jar/String.class", range: range(0, 0) }])[0]).toMatchObject({
      path: null,
      uri: "jdt://contents/rt.jar/String.class",
    });
  });

  it("flattens a DocumentSymbol tree with depth, and reads SymbolInformation with its container", () => {
    const tree = [
      {
        name: "Server",
        kind: 5,
        range: range(0, 0),
        selectionRange: range(0, 13),
        children: [{ name: "start", kind: 6, range: range(3, 2), selectionRange: range(3, 2) }],
      },
    ];
    expect(parseSymbols(tree, URI)).toEqual([
      { path: FILE, uri: URI, line: 1, col: 14, label: "class Server", depth: 0 },
      { path: FILE, uri: URI, line: 4, col: 3, label: "method start", depth: 1 },
    ]);
    const flat = [{ name: "load", kind: 12, containerName: "config", location: { uri: OTHER_URI, range: range(19, 0) } }];
    expect(parseSymbols(flat, URI)).toEqual([
      { path: OTHER, uri: OTHER_URI, line: 20, col: 1, label: "function load (in config)" },
    ]);
    // A WorkspaceSymbol may carry a location without a range.
    expect(parseSymbols([{ name: "X", kind: 23, location: { uri: OTHER_URI } }], URI)[0]).toMatchObject({ line: 0, label: "struct X" });
  });

  it("reads hover contents in all three spellings", () => {
    expect(parseHover({ contents: "plain" })).toBe("plain");
    expect(parseHover({ contents: { language: "go", value: "func Main()" } })).toBe("```go\nfunc Main()\n```");
    expect(parseHover({ contents: [{ language: "ts", value: "x: number" }, "The x."] })).toBe("```ts\nx: number\n```\n\nThe x.");
    expect(parseHover({ contents: { kind: "plaintext", value: "  " } })).toBeNull();
    expect(parseHover(null)).toBeNull();
  });
});
