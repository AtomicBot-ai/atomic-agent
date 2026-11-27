import { randomBytes } from "node:crypto";

import type { AgentRuntime } from "../runtime/bootstrap.js";
import { createHttpServer } from "./http-server.js";
import { RAW_MODEL_PREFIX, type RawModelHandlers } from "./route-raw-model.js";
import type { ModelShareSettings } from "./model-share-settings.js";

/**
 * ATO-2483: the shared model's own listener.
 *
 * serve's main listener stays where it was started (the desktop starts it
 * on 127.0.0.1 and a free port). Sharing on the network must not open the
 * agent's routes there, so the shared model gets a second, small listener
 * that has the two `/raw/v1` routes and nothing else: every other path is
 * 404. It is on 127.0.0.1 in `local` mode and on 0.0.0.0 in `network`
 * mode, on `localModels.managed.sharePort` (8787 by default), and closed
 * while sharing is off. LM Studio's server works the same way: one switch
 * moves its API from localhost to every interface.
 *
 * The handlers are serve's own (route-table.ts): the same key check, auth
 * throttle (by the caller's real address) and one-request cap, so two
 * listeners still let only one raw request run at a time.
 *
 * When serve itself already listens on that port, the main listener answers
 * `/raw/v1` (a terminal `atomic-agent serve` on 8787): no second listener.
 */

export type ShareListenerState =
  | { state: "off" }
  | { state: "listening"; host: string; port: number }
  /** serve's main listener is on that port and answers `/raw/v1` itself. */
  | { state: "main"; port: number; network: boolean }
  /** The port could not be opened; `problem` in words a window can show. */
  | { state: "failed"; host: string; port: number; problem: "port-busy" | "not-allowed" | "failed" };

export interface ListenerHandle {
  port: number;
  close: () => Promise<void>;
}

export interface ModelShareListenerDeps {
  runtime: AgentRuntime;
  rawModel: RawModelHandlers;
  /** Where serve's main listener is (null before it listens), so its own port is not opened twice. */
  main: () => { host: string; port: number } | null;
  /** Tests replace the socket. */
  listen?: (host: string, port: number) => Promise<ListenerHandle>;
  /** One line to stderr; never holds the key. */
  say?: (line: string) => void;
}

export interface ModelShareListener {
  /**
   * Open, move or close the listener for `settings`; resolves to where it
   * is now. Calls run one after another. `retry: false` (serve's periodic
   * re-read of the file) leaves a port that failed alone instead of trying
   * it, and logging it, again; a person's change always tries.
   */
  apply: (settings: ModelShareSettings, options?: { retry?: boolean }) => Promise<ShareListenerState>;
  current: () => ShareListenerState;
  close: () => Promise<void>;
}

export const SHARE_LISTEN_HOSTS = { local: "127.0.0.1", network: "0.0.0.0" } as const;

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function problemOf(err: unknown): "port-busy" | "not-allowed" | "failed" {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE") return "port-busy";
  if (code === "EACCES" || code === "EPERM") return "not-allowed";
  return "failed";
}

export function createModelShareListener(deps: ModelShareListenerDeps): ModelShareListener {
  const say = deps.say ?? ((line: string) => process.stderr.write(line));
  const listen =
    deps.listen ??
    (async (host: string, port: number): Promise<ListenerHandle> => {
      const handle = await createHttpServer({
        runtime: deps.runtime,
        host,
        port,
        // No route here takes it: both raw routes check the share key
        // themselves. createHttpServer requires one, so it gets a key
        // nobody holds.
        apiKey: randomBytes(32).toString("hex"),
        routes: [
          { method: "GET", path: `${RAW_MODEL_PREFIX}/models`, handler: deps.rawModel.models, requiresAuth: false },
          { method: "POST", path: `${RAW_MODEL_PREFIX}/chat/completions`, handler: deps.rawModel.chatCompletions, requiresAuth: false },
        ],
      });
      return { port: handle.port, close: () => handle.close() };
    });

  let state: ShareListenerState = { state: "off" };
  let open: { host: string; port: number; handle: ListenerHandle } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const closeOpen = async (): Promise<void> => {
    const was = open;
    open = null;
    if (was) await was.handle.close().catch(() => {});
  };

  const applyNow = async (settings: ModelShareSettings, retry: boolean): Promise<ShareListenerState> => {
    if (settings.mode === "off") {
      if (open) say("[atomic-agent] model share: stopped listening\n");
      await closeOpen();
      state = { state: "off" };
      return state;
    }
    const main = deps.main();
    if (main && main.port === settings.port) {
      await closeOpen();
      state = { state: "main", port: settings.port, network: !isLoopbackHost(main.host) };
      return state;
    }
    const host = SHARE_LISTEN_HOSTS[settings.mode];
    if (open && open.host === host && open.port === settings.port) return state;
    if (!retry && state.state === "failed" && state.host === host && state.port === settings.port) return state;
    await closeOpen();
    try {
      const handle = await listen(host, settings.port);
      open = { host, port: settings.port, handle };
      state = { state: "listening", host, port: handle.port };
      say(`[atomic-agent] model share: ${RAW_MODEL_PREFIX} listening on http://${host}:${handle.port}\n`);
      if (settings.mode === "network") {
        say(`[atomic-agent] warning: ${RAW_MODEL_PREFIX} is reachable from the local network over plain http; anyone on this network can read the traffic\n`);
      }
    } catch (err) {
      state = { state: "failed", host, port: settings.port, problem: problemOf(err) };
      say(`[atomic-agent] model share: could not listen on ${host}:${settings.port} (${state.problem})\n`);
    }
    return state;
  };

  return {
    apply: (settings, options) => {
      const run = queue.then(() => applyNow(settings, options?.retry !== false));
      queue = run.catch(() => {});
      return run;
    },
    current: () => state,
    close: async () => {
      await queue.catch(() => {});
      await closeOpen();
      state = { state: "off" };
    },
  };
}
