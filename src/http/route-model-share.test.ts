import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readUserConfigFileSync, resetConfigCache } from "../config/index.js";
import { createHttpServer, type HttpServerHandle } from "./http-server.js";
import { ROUTE_SCOPES } from "./http-scopes.js";
import type { ModelShareListener, ShareListenerState } from "./model-share-listener.js";
import type { ModelShareSettings } from "./model-share-settings.js";
import { readModelShareKey } from "./model-share-key.js";
import { buildRouteTable } from "./route-table.js";

/** ATO-2483: GET / POST /api/model-share, what Settings › Models "Share this model" reads and sets. */

const AGENT_KEY = "agent-key-0123456789abcdef";

let stateDir: string;
let handle: HttpServerHandle | null = null;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "route-model-share-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  resetConfigCache();
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

function fakeListener(applied: ModelShareSettings[]): ModelShareListener {
  let state: ShareListenerState = { state: "off" };
  return {
    apply: async (settings) => {
      applied.push(settings);
      state = settings.mode === "off" ? { state: "off" } : { state: "listening", host: settings.mode === "network" ? "0.0.0.0" : "127.0.0.1", port: settings.port };
      return state;
    },
    current: () => state,
    close: async () => {},
  };
}

async function start(listener: ModelShareListener | null): Promise<string> {
  handle = await createHttpServer({
    runtime: {} as never,
    host: "127.0.0.1",
    port: 0,
    apiKey: AGENT_KEY,
    routes: buildRouteTable({ modelShare: listener }),
  });
  return `http://127.0.0.1:${handle.port}`;
}

const auth = { authorization: `Bearer ${AGENT_KEY}`, "content-type": "application/json" };

function set(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/model-share`, { method: "POST", headers: auth, body: JSON.stringify(body) });
}

interface Answer {
  mode: string;
  port: number;
  key: string | null;
  urls: { local: string; lan: string[] };
  listener: ShareListenerState | null;
}

describe("/api/model-share", () => {
  it("is off with no key until it is turned on", async () => {
    const base = await start(fakeListener([]));
    const res = await fetch(`${base}/api/model-share`, { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()) as Answer).toMatchObject({ mode: "off", key: null, port: 8787, urls: { local: "http://127.0.0.1:8787/raw/v1", lan: [] } });
  });

  it("turns local sharing on: writes the file, makes the key, opens the listener", async () => {
    const applied: ModelShareSettings[] = [];
    const base = await start(fakeListener(applied));
    const body = (await (await set(base, { mode: "local" })).json()) as Answer;
    expect(body.mode).toBe("local");
    expect(body.key).toBe(readModelShareKey(stateDir));
    expect(body.key?.length).toBeGreaterThan(20);
    expect(body.urls.lan).toEqual([]);
    expect(body.listener).toEqual({ state: "listening", host: "127.0.0.1", port: 8787 });
    expect(applied).toEqual([{ mode: "local", port: 8787 }]);
    expect(readUserConfigFileSync(join(stateDir, "config.json"))?.localModels.managed.share).toBe(true);
  });

  it("network mode lists the LAN addresses; rotate replaces the key; off forgets the network", async () => {
    const base = await start(fakeListener([]));
    const first = (await (await set(base, { mode: "network" })).json()) as Answer;
    expect(first.listener).toMatchObject({ host: "0.0.0.0" });
    const rotated = (await (await set(base, { mode: "network", rotate: true })).json()) as Answer;
    expect(rotated.key).not.toBe(first.key);
    expect(rotated.key).toBe(readModelShareKey(stateDir));

    const off = (await (await set(base, { mode: "off" })).json()) as Answer;
    expect(off).toMatchObject({ mode: "off", key: null, listener: { state: "off" } });
    expect(readUserConfigFileSync(join(stateDir, "config.json"))?.localModels.managed.shareNetwork).toBeUndefined();
  });

  it("refuses a mode it does not know, and a caller without the agent key", async () => {
    const base = await start(fakeListener([]));
    expect((await set(base, { mode: "everywhere" })).status).toBe(400);
    expect((await set(base, { mode: "local", rotate: "yes" })).status).toBe(400);
    expect((await fetch(`${base}/api/model-share`)).status).toBe(401);
  });

  it("needs the admin scope both ways, since the answer carries the key", () => {
    expect(ROUTE_SCOPES["GET /api/model-share"]).toBe("admin");
    expect(ROUTE_SCOPES["POST /api/model-share"]).toBe("admin");
  });
});
