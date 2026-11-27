import { afterEach, describe, expect, it } from "vitest";

import { createModelShareListener, type ListenerHandle, type ModelShareListener } from "./model-share-listener.js";
import { createRawModelHandlers, type RawModelShareDeps } from "./route-raw-model.js";

/** ATO-2483: the shared model's own listener, which has the raw routes and nothing else. */

const SHARE_KEY = "share-key-fedcba9876543210";

function rawDeps(): RawModelShareDeps {
  return {
    isEnabled: () => true,
    readKey: () => SHARE_KEY,
    upstream: () => ({ baseUrl: "http://127.0.0.1:9", apiKey: "upstream-secret" }),
    fetch: (async () =>
      new Response(JSON.stringify({ object: "list", data: [{ id: "gemma-local" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  };
}

interface FakeSockets {
  opened: Array<{ host: string; port: number }>;
  closed: Array<{ host: string; port: number }>;
  fail: NodeJS.ErrnoException | null;
}

function fakeListen(s: FakeSockets) {
  return async (host: string, port: number): Promise<ListenerHandle> => {
    if (s.fail) throw s.fail;
    s.opened.push({ host, port });
    return { port, close: async () => void s.closed.push({ host, port }) };
  };
}

let live: ModelShareListener | null = null;
afterEach(async () => {
  if (live) await live.close();
  live = null;
});

describe("model share listener", () => {
  it("opens on 127.0.0.1 for local, moves to 0.0.0.0 for network, closes for off", async () => {
    const s: FakeSockets = { opened: [], closed: [], fail: null };
    const lines: string[] = [];
    const l = createModelShareListener({
      runtime: {} as never,
      rawModel: createRawModelHandlers(rawDeps()),
      main: () => ({ host: "127.0.0.1", port: 51234 }),
      listen: fakeListen(s),
      say: (line) => lines.push(line),
    });
    expect(l.current()).toEqual({ state: "off" });
    expect(await l.apply({ mode: "local", port: 8787 })).toEqual({ state: "listening", host: "127.0.0.1", port: 8787 });
    // The same settings again open nothing new.
    await l.apply({ mode: "local", port: 8787 });
    expect(s.opened).toEqual([{ host: "127.0.0.1", port: 8787 }]);

    expect(await l.apply({ mode: "network", port: 8787 })).toEqual({ state: "listening", host: "0.0.0.0", port: 8787 });
    expect(s.closed).toEqual([{ host: "127.0.0.1", port: 8787 }]);
    expect(lines.join("")).toContain("plain http");

    expect(await l.apply({ mode: "off", port: 8787 })).toEqual({ state: "off" });
    expect(s.closed).toEqual([{ host: "127.0.0.1", port: 8787 }, { host: "0.0.0.0", port: 8787 }]);
    expect(lines.join("")).not.toContain(SHARE_KEY);
  });

  it("opens no second listener on serve's own port, and says whether that one is on the network", async () => {
    const s: FakeSockets = { opened: [], closed: [], fail: null };
    const make = (host: string) =>
      createModelShareListener({ runtime: {} as never, rawModel: createRawModelHandlers(rawDeps()), main: () => ({ host, port: 8787 }), listen: fakeListen(s), say: () => {} });
    expect(await make("127.0.0.1").apply({ mode: "network", port: 8787 })).toEqual({ state: "main", port: 8787, network: false });
    expect(await make("0.0.0.0").apply({ mode: "local", port: 8787 })).toEqual({ state: "main", port: 8787, network: true });
    expect(s.opened).toEqual([]);
  });

  it("reports a busy port, and the periodic re-read does not try it again; a person's change does", async () => {
    const busy = Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
    const s: FakeSockets = { opened: [], closed: [], fail: busy };
    const lines: string[] = [];
    const l = createModelShareListener({
      runtime: {} as never,
      rawModel: createRawModelHandlers(rawDeps()),
      main: () => null,
      listen: fakeListen(s),
      say: (line) => lines.push(line),
    });
    expect(await l.apply({ mode: "network", port: 8787 })).toEqual({ state: "failed", host: "0.0.0.0", port: 8787, problem: "port-busy" });
    await l.apply({ mode: "network", port: 8787 }, { retry: false });
    expect(lines).toHaveLength(1);
    s.fail = null;
    expect(await l.apply({ mode: "network", port: 8787 })).toMatchObject({ state: "listening" });
  });

  it("serves the raw routes for the share key, and 404 for every agent route", async () => {
    live = createModelShareListener({
      runtime: {} as never,
      rawModel: createRawModelHandlers(rawDeps()),
      main: () => null,
      say: () => {},
    });
    const st = await live.apply({ mode: "local", port: 0 });
    if (st.state !== "listening") throw new Error(`not listening: ${JSON.stringify(st)}`);
    const base = `http://127.0.0.1:${st.port}`;
    const auth = { authorization: `Bearer ${SHARE_KEY}` };

    const models = await fetch(`${base}/raw/v1/models`, { headers: auth });
    expect(models.status).toBe(200);
    expect(await models.text()).not.toContain("upstream-secret");
    expect((await fetch(`${base}/raw/v1/models`)).status).toBe(401);

    for (const path of ["/api/config", "/api/capabilities", "/health", "/v1/models", "/api/model-share"]) {
      expect((await fetch(`${base}${path}`, { headers: auth })).status).toBe(404);
    }
    const agentChat = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    expect(agentChat.status).toBe(404);
  });
});
