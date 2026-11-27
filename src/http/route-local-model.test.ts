import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import type { LocalModelDeps } from "./route-local-model.js";

/** ATO-2447: serve's `/local/v1` routes, end to end against a fake llama-server. */

const AGENT_KEY = "agent-key-0123456789abcdef";
const UPSTREAM_KEY = "upstream-secret-never-returned";

interface Seen {
  url: string;
  authorization: string | undefined;
  body: string;
}

interface FakeModel {
  url: string;
  seen: Seen[];
  stop: () => Promise<void>;
}

const TOOL_USE_ANSWER = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } }],
  stop_reason: "tool_use",
};

async function startFakeModel(): Promise<FakeModel> {
  const seen: Seen[] = [];
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json", "x-upstream-only": "1" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "qwen-local", object: "model" }] }));
        return;
      }
      if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(TOOL_USE_ANSWER));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"bash"}}]}}]}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" }).end("File Not Found");
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`,
    seen,
    stop: () => new Promise((resolve) => srv.close(() => resolve())),
  };
}

async function closedPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createTcpServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let handle: HttpServerHandle | null = null;
let model: FakeModel | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  if (model) await model.stop();
  handle = null;
  model = null;
});

async function start(deps?: LocalModelDeps): Promise<string> {
  model = await startFakeModel();
  const upstreamUrl = model.url;
  handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: AGENT_KEY,
    routes: buildRouteTable({ localModel: deps ?? { upstream: () => ({ baseUrl: upstreamUrl, apiKey: UPSTREAM_KEY }) } }),
  });
  return `http://127.0.0.1:${handle.port}`;
}

const auth = { authorization: `Bearer ${AGENT_KEY}`, "content-type": "application/json" };

describe("local model routes (ATO-2447)", () => {
  it("passes an Anthropic Messages request with the CLI's tools to the model and returns tool_use unchanged", async () => {
    const base = await start();
    const request = {
      model: "claude-sonnet",
      max_tokens: 100,
      tools: [{ name: "Read", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "read a.ts" }],
    };
    const res = await fetch(`${base}/local/v1/messages`, { method: "POST", headers: auth, body: JSON.stringify(request) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TOOL_USE_ANSWER);
    const seen = model?.seen[0];
    expect(seen?.url).toBe("/v1/messages");
    expect(JSON.parse(seen?.body ?? "{}")).toEqual(request);
    // The model server gets its own key, never the serve key.
    expect(seen?.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
  });

  it("streams chat completions with tool_calls through, and lists the model", async () => {
    const base = await start();
    const res = await fetch(`${base}/local/v1/chat/completions`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ stream: true, messages: [], tools: [{ type: "function", function: { name: "bash" } }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"tool_calls"');
    const models = await fetch(`${base}/local/v1/models`, { headers: auth });
    expect(((await models.json()) as { data: { id: string }[] }).data[0]?.id).toBe("qwen-local");
    expect(models.headers.get("x-upstream-only")).toBeNull();
  });

  it("needs the serve key: no key or a wrong one is 401 and never reaches the model", async () => {
    const base = await start();
    for (const headers of [{}, { authorization: "Bearer wrong" }]) {
      const res = await fetch(`${base}/local/v1/models`, { headers });
      expect(res.status).toBe(401);
    }
    expect(model?.seen).toEqual([]);
  });

  it("answers an engine without the API with a clear 404 in that API's error shape", async () => {
    const base = await start();
    const res = await fetch(`${base}/local/v1/responses`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("endpoint_unsupported");
    expect(body.error.message).toContain("atag models update");
  });

  it("a model that is not running is 502 with how to start it, Anthropic-shaped on /messages", async () => {
    const port = await closedPort();
    const base = await start({ upstream: () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: null }) });
    const res = await fetch(`${base}/local/v1/messages`, { method: "POST", headers: auth, body: "{}" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type: string; error: { message: string } };
    expect(body.type).toBe("error");
    expect(body.error.message).toContain("atag models start");
  });

  it("takes a body past the 1 MiB cap of the agent routes", async () => {
    const base = await start();
    const big = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }] });
    const res = await fetch(`${base}/local/v1/messages`, { method: "POST", headers: auth, body: big });
    expect(res.status).toBe(200);
    expect(model?.seen[0]?.body.length).toBe(big.length);
  });
});
