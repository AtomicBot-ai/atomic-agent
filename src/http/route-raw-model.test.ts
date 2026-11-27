import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { buildRouteTable } from "./route-table.js";
import { upstreamV1Url, type RawModelShareDeps } from "./route-raw-model.js";

/** ATO-2336: serve's `/raw/v1` routes, end to end against a fake llama-server. */

const AGENT_KEY = "agent-key-0123456789abcdef";
const SHARE_KEY = "share-key-fedcba9876543210";
const UPSTREAM_KEY = "upstream-secret-never-returned";

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

interface FakeModel {
  url: string;
  seen: SeenRequest[];
  /** Resolves when the next chat request reaches the model. */
  nextArrival: () => Promise<void>;
  /** Hold chat answers until `release()`. */
  hold: boolean;
  release: () => void;
  stop: () => Promise<void>;
}

async function startFakeModel(): Promise<FakeModel> {
  const seen: SeenRequest[] = [];
  const held: ServerResponse[] = [];
  let arrival: (() => void) | null = null;
  const fake: FakeModel = {
    url: "",
    seen,
    hold: false,
    nextArrival: () => new Promise<void>((resolve) => { arrival = resolve; }),
    release: () => {
      for (const res of held.splice(0)) answerChat(res, false);
    },
    stop: () => new Promise((resolve) => srv.close(() => resolve())),
  };
  const srv: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, body });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json", "x-upstream-only": "1" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gemma-local", object: "model" }] }));
        return;
      }
      if (req.url === "/v1/chat/completions") {
        arrival?.();
        arrival = null;
        if (fake.hold) {
          held.push(res);
          return;
        }
        answerChat(res, (JSON.parse(body) as { stream?: boolean }).stream === true);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const address = srv.address();
  fake.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return fake;
}

function answerChat(res: ServerResponse, stream: boolean): void {
  if (!stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", choices: [{ message: { role: "assistant", content: "hi" } }] }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
  setTimeout(() => {
    res.write('data: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  }, 20);
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
  if (model) model.release();
  if (handle) await handle.close();
  if (model) await model.stop();
  handle = null;
  model = null;
});

async function start(overrides: Partial<RawModelShareDeps> = {}): Promise<string> {
  model = await startFakeModel();
  const upstreamUrl = model.url;
  const deps: RawModelShareDeps = {
    isEnabled: () => true,
    readKey: () => SHARE_KEY,
    upstream: () => ({ baseUrl: upstreamUrl, apiKey: UPSTREAM_KEY }),
    ...overrides,
  };
  handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: AGENT_KEY,
    routes: buildRouteTable({ rawModel: deps }),
  });
  return `http://127.0.0.1:${handle.port}`;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

function chat(base: string, key: string | null, stream = false): Promise<Response> {
  return fetch(`${base}/raw/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? bearer(key) : {}) },
    body: JSON.stringify({ model: "any", stream, messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("raw model share routes", () => {
  it("answers 404 on both routes while sharing is off, and never reaches the model", async () => {
    const base = await start({ isEnabled: () => false });
    const models = await fetch(`${base}/raw/v1/models`, { headers: bearer(SHARE_KEY) });
    expect(models.status).toBe(404);
    expect((await chat(base, SHARE_KEY)).status).toBe(404);
    expect(model?.seen).toEqual([]);
  });

  it("refuses a request without a key, with a wrong key, and with the agent's own key (401)", async () => {
    const base = await start();
    for (const key of [null, "wrong-key", AGENT_KEY]) {
      const res = await chat(base, key);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");
    }
    expect(model?.seen).toEqual([]);
  });

  it("refuses with 503 when sharing is on but no key was made", async () => {
    const base = await start({ readKey: () => null });
    const res = await chat(base, SHARE_KEY);
    expect(res.status).toBe(503);
    expect(model?.seen).toEqual([]);
  });

  it("forwards /models and a chat completion with the model's own key, which never comes back", async () => {
    const base = await start();
    const models = await fetch(`${base}/raw/v1/models`, { headers: bearer(SHARE_KEY) });
    expect(models.status).toBe(200);
    expect(models.headers.get("x-upstream-only")).toBeNull();
    expect(((await models.json()) as { data: { id: string }[] }).data[0]?.id).toBe("gemma-local");

    const res = await chat(base, SHARE_KEY);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text).choices[0].message.content).toBe("hi");
    expect(text).not.toContain(UPSTREAM_KEY);

    expect(model?.seen.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /v1/models", "POST /v1/chat/completions"]);
    for (const r of model?.seen ?? []) expect(r.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(JSON.parse(model?.seen[1]?.body ?? "{}").messages[0].content).toBe("hello");
  });

  it("passes a streamed answer through as SSE", async () => {
    const base = await start();
    const res = await chat(base, SHARE_KEY, true);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"content":"he"');
    expect(body).toContain('"content":"llo"');
    expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("lets one request in at a time: a second gets 429 until the first is done", async () => {
    const base = await start();
    if (!model) throw new Error("no model");
    model.hold = true;
    const arrived = model.nextArrival();
    const first = chat(base, SHARE_KEY);
    await arrived;

    const second = await chat(base, SHARE_KEY);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("model_busy");

    model.release();
    expect((await first).status).toBe(200);
    model.hold = false;
    expect((await chat(base, SHARE_KEY)).status).toBe(200);
  });

  it("answers 502 when the local model is not running", async () => {
    const port = await closedPort();
    const base = await start({ upstream: () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: null }) });
    const res = await chat(base, SHARE_KEY);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_unreachable");
  });

  it("does not let the share key into an agent route", async () => {
    const base = await start();
    const agentChat = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(SHARE_KEY) },
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(agentChat.status).toBe(401);
    const config = await fetch(`${base}/api/config`, { headers: bearer(SHARE_KEY) });
    expect(config.status).toBe(401);
    const capabilities = await fetch(`${base}/api/capabilities`, { headers: bearer(SHARE_KEY) });
    expect(capabilities.status).toBe(401);
  });
});

describe("upstreamV1Url", () => {
  it("adds /v1 once, whether or not the base already ends with it", () => {
    expect(upstreamV1Url("http://127.0.0.1:19091", "/models")).toBe("http://127.0.0.1:19091/v1/models");
    expect(upstreamV1Url("http://127.0.0.1:19091/", "/models")).toBe("http://127.0.0.1:19091/v1/models");
    expect(upstreamV1Url("http://127.0.0.1:9931/v1/", "/chat/completions")).toBe("http://127.0.0.1:9931/v1/chat/completions");
  });
});
