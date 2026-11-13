/**
 * `atag serve --tunnel` (ATO-625): deliver GitHub / Stripe / any webhook
 * to this machine through a Cloudflare tunnel, with no server of your own
 * and no open port.
 *
 * What is exposed is deliberately small. cloudflared is pointed at a
 * second listener on a random loopback port whose route table holds only
 * `POST /api/webhooks/{name}` (`buildTunnelRouteTable`); the main API,
 * on its own port, is never the tunnel's origin. That gateway has no
 * bearer key in front of it, so it serves only bindings that have a
 * `secret`, and each hit must pass the binding's `verify` scheme (the
 * `x-webhook-secret` header, or a GitHub / Standard Webhooks / Stripe
 * signature). Signed bindings also get replay protection there: a
 * repeated delivery id answers 200 and runs nothing, and a signature
 * timestamp more than 5 minutes old is refused. serve refuses to start
 * the tunnel when no binding has a secret. There is deliberately no
 * option to point the tunnel at the main API port.
 */

import type { WebhookConfig } from "../config/index.js";
import {
  buildTunnelRouteTable,
  createHttpServer,
  resetWebhookTunnelStatus,
  setWebhookTunnelStatus,
  type ApprovalBus,
  type CompletionRegistry,
  type HttpServerHandle,
} from "../http/index.js";
import type { AgentRuntime } from "../runtime/bootstrap.js";

import {
  CLOUDFLARED_INSTALL_HINT,
  findOnPath,
  startCloudflared,
  type CloudflaredHandle,
  type SpawnLike,
  type TunnelRequest,
} from "./cloudflared.js";

export type TunnelPreflight =
  | { ok: true; binary: string; reachable: string[]; withoutSecret: string[] }
  | { ok: false; error: string };

/**
 * Decide, before anything boots, whether the tunnel may start. Refuses
 * when cloudflared is not on PATH, when the tasks subsystem is off (every
 * webhook would answer 404), and when no binding has a secret (the tunnel
 * would open a public address that serves nothing safely).
 */
export function tunnelPreflight(input: {
  webhooks: Record<string, WebhookConfig>;
  tasksEnabled: boolean;
  findBinary?: () => string | null;
}): TunnelPreflight {
  const binary = (input.findBinary ?? (() => findOnPath("cloudflared")))();
  if (!binary) {
    return { ok: false, error: `--tunnel needs cloudflared on PATH, and it was not found. ${CLOUDFLARED_INSTALL_HINT}` };
  }
  if (!input.tasksEnabled) {
    return {
      ok: false,
      error: "--tunnel delivers webhooks as tasks, and tasks are off (tasks.enabled is false in the config). Turn them on first.",
    };
  }
  const reachable: string[] = [];
  const withoutSecret: string[] = [];
  for (const [name, webhook] of Object.entries(input.webhooks)) {
    if (typeof webhook.secret === "string" && webhook.secret.length > 0) reachable.push(name);
    else withoutSecret.push(name);
  }
  if (reachable.length === 0) {
    const why =
      withoutSecret.length === 0
        ? "no webhooks are configured"
        : `no webhook has a secret (${withoutSecret.join(", ")})`;
    return {
      ok: false,
      error:
        `--tunnel refuses to open a public address because ${why}. ` +
        "Add a webhook with a `secret` under `webhooks` in the config; for GitHub or Stripe also set `verify` to `github` or `stripe` so every delivery's signature is checked.",
    };
  }
  return { ok: true, binary, reachable, withoutSecret };
}

export interface WebhookTunnel {
  /** The gateway's loopback port, which cloudflared forwards to. */
  readonly gatewayPort: number;
  /** Resolves once cloudflared reported its public address (or gave up). */
  readonly ready: Promise<string | null>;
  stop(): Promise<void>;
}

export interface StartWebhookTunnelOptions {
  runtime: AgentRuntime;
  request: TunnelRequest;
  preflight: Extract<TunnelPreflight, { ok: true }>;
  approvalBus: ApprovalBus;
  completionRegistry: CompletionRegistry;
  write: (line: string) => void;
  spawn?: SpawnLike;
  urlTimeoutMs?: number;
}

export async function startWebhookTunnel(options: StartWebhookTunnelOptions): Promise<WebhookTunnel> {
  const { request, preflight, write } = options;
  const gateway: HttpServerHandle = await createHttpServer({
    runtime: options.runtime,
    host: "127.0.0.1",
    port: 0,
    apiKey: null,
    routes: buildTunnelRouteTable(),
    approvalBus: options.approvalBus,
    completionRegistry: options.completionRegistry,
  });
  setWebhookTunnelStatus({ state: "starting", mode: request.mode, publicUrl: null, error: null });
  let stopping = false;
  let cloudflared: CloudflaredHandle;
  try {
    cloudflared = startCloudflared({
      binary: preflight.binary,
      request,
      originUrl: `http://127.0.0.1:${gateway.port}`,
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.urlTimeoutMs !== undefined ? { urlTimeoutMs: options.urlTimeoutMs } : {}),
      onExit: (code, signal) => {
        if (stopping) return;
        const error = `cloudflared exited (${signal ?? `code ${code}`})`;
        setWebhookTunnelStatus({ state: "failed", mode: request.mode, publicUrl: null, error });
        write(`[atomic-agent] tunnel: ${error}; webhooks are no longer reachable from the internet\n`);
      },
    });
  } catch (err) {
    await gateway.close();
    resetWebhookTunnelStatus();
    throw err;
  }

  const ready = cloudflared.publicUrl.then((url) => {
    if (stopping) return url;
    if (!url) {
      const error = "cloudflared did not report a public address";
      setWebhookTunnelStatus({ state: "failed", mode: request.mode, publicUrl: null, error });
      const tail = cloudflared.recentLog().slice(-5).join("\n  ");
      write(`[atomic-agent] tunnel: ${error}${tail ? `; its last lines:\n  ${tail}` : ""}\n`);
      return null;
    }
    setWebhookTunnelStatus({ state: "up", mode: request.mode, publicUrl: url, error: null });
    write(`[atomic-agent] tunnel up at ${url} (only /api/webhooks/* is reachable through it)\n`);
    for (const name of preflight.reachable) {
      write(`[atomic-agent] webhook ${name}: ${url}/api/webhooks/${encodeURIComponent(name)}\n`);
    }
    if (preflight.withoutSecret.length > 0) {
      write(
        `[atomic-agent] tunnel: not reachable without a secret: ${preflight.withoutSecret.join(", ")}\n`,
      );
    }
    return url;
  });

  return {
    gatewayPort: gateway.port,
    ready,
    stop: async () => {
      stopping = true;
      try {
        await cloudflared.stop();
      } finally {
        await gateway.close();
        resetWebhookTunnelStatus();
      }
    },
  };
}
