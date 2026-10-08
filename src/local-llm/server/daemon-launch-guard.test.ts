import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPortFree,
  fetchServedModelIds,
  PortTakenError,
  waitForOwnDaemon,
  type WaitForOwnDaemonOptions,
} from "./daemon-launch-guard.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

/** A llama-server look-alike: `/health` ok, `/v1/models` lists `models`. */
async function llamaLike(models: string[] | null): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/v1/models" && models !== null) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on: bind one, remember it, close it. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(() => r(null)));
  return port;
}

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
}

function opts(
  over: Partial<WaitForOwnDaemonOptions> & Pick<WaitForOwnDaemonOptions, "child" | "port">,
): WaitForOwnDaemonOptions {
  return {
    alias: "qwen-3.8-27b-uncensored",
    timeoutMs: 5_000,
    label: "llama-server",
    probeHealth: async () => "down",
    readLog: () => "",
    makeHealthError: (m) => new Error(`health: ${m}`),
    pollMs: 20,
    ...over,
  };
}

describe("assertPortFree", () => {
  it("passes when nothing answers on the port", async () => {
    await expect(assertPortFree(await deadPort())).resolves.toBeUndefined();
  });

  it("refuses a port another llama-server holds, naming what it serves", async () => {
    const port = await llamaLike(["qwen-3.5-4b"]);
    const err = await assertPortFree(port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortTakenError);
    expect((err as PortTakenError).servedModels).toEqual(["qwen-3.5-4b"]);
    expect((err as Error).message).toContain(`port ${port} is already served`);
    expect((err as Error).message).toContain("qwen-3.5-4b");
  });

  it("refuses a holder that is not llama.cpp at all (404 on everything)", async () => {
    const port = await llamaLike(null);
    await expect(assertPortFree(port)).rejects.toBeInstanceOf(PortTakenError);
  });
});

describe("fetchServedModelIds", () => {
  it("reads the ids, and says null when nothing answers", async () => {
    expect(await fetchServedModelIds(await llamaLike(["a", "b"]))).toEqual(["a", "b"]);
    expect(await fetchServedModelIds(await deadPort())).toBeNull();
  });
});

describe("waitForOwnDaemon", () => {
  it("cancels a superseded loading wait without waiting for the health deadline", async () => {
    const controller = new AbortController();
    const child = fakeChild();
    let probes = 0;
    await expect(waitForOwnDaemon(opts({
      child, port: await deadPort(), signal: controller.signal,
      probeHealth: async () => { probes++; controller.abort(); return "loading"; },
    }))).rejects.toMatchObject({ name: "AbortError" });
    expect(probes).toBe(1);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("ends the wait the moment the child exits on a bind failure — as PortTakenError", async () => {
    const child = fakeChild();
    const port = await llamaLike(["qwen-3.5-4b"]);
    const started = Date.now();
    const wait = waitForOwnDaemon(
      opts({
        child,
        port,
        // The neighbour answers /health — exactly what used to pass the wait.
        probeHealth: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return "down";
        },
        readLog: () =>
          "[atomic-agent] launch: model x\nstart: couldn't bind HTTP server socket, hostname: 127.0.0.1\n",
      }),
    );
    setTimeout(() => child.emit("exit", 1, null), 30);
    const err = await wait.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PortTakenError);
    expect((err as PortTakenError).servedModels).toEqual(["qwen-3.5-4b"]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("never lets a neighbour's /health stand in for a child that already died", async () => {
    const child = fakeChild();
    child.emit("exit", 1, null);
    Object.assign(child, { exitCode: 1 });
    const err = await waitForOwnDaemon(
      opts({ child, port: await deadPort(), probeHealth: async () => "ok" }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain("health: llama-server exited (code 1) before it became healthy");
  });

  it("reports the recognised fault of a child that died for another reason", async () => {
    const child = fakeChild();
    const wait = waitForOwnDaemon(
      opts({
        child,
        port: await deadPort(),
        readLog: () => "ggml_metal: kIOGPUCommandBufferCallbackErrorOutOfMemory\n",
      }),
    );
    setTimeout(() => child.emit("exit", null, "SIGABRT"), 30);
    const err = await wait.catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^health: llama-server exited \(signal SIGABRT\) before it became healthy — the GPU ran out of memory 1 time/);
    expect((err as Error).message).toContain("Log tail:");
  });

  it("refuses a healthy port that serves a different model", async () => {
    const port = await llamaLike(["qwen-3.5-4b"]);
    const err = await waitForOwnDaemon(
      opts({ child: fakeChild(), port, probeHealth: async () => "ok" }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain(
      `health: port ${port} answered for model qwen-3.5-4b, not qwen-3.8-27b-uncensored`,
    );
  });

  it("accepts its own alias, and a build that has no /v1/models", async () => {
    const own = await llamaLike(["qwen-3.8-27b-uncensored"]);
    await expect(
      waitForOwnDaemon(opts({ child: fakeChild(), port: own, probeHealth: async () => "ok" })),
    ).resolves.toBeUndefined();
    const silent = await llamaLike(null);
    await expect(
      waitForOwnDaemon(opts({ child: fakeChild(), port: silent, probeHealth: async () => "ok" })),
    ).resolves.toBeUndefined();
  });

  it("still times out as a health error when the child neither exits nor serves", async () => {
    const err = await waitForOwnDaemon(
      opts({ child: fakeChild(), port: await deadPort(), timeoutMs: 120 }),
    ).catch((e: unknown) => e);
    expect((err as Error).message).toContain("health: llama-server did not become healthy within 120ms");
  });
});
