import type { RouteDefinition } from "./http-server.js";
import { createWebhookHandler } from "./route-webhooks.js";

/**
 * The route table of the tunnel gateway (ATO-625): the second, loopback
 * only listener `atag serve --tunnel` points cloudflared at. It holds the
 * webhook route and nothing else, so a request that comes in from the
 * internet can never reach chat, config, skills, sessions, the panel or
 * any other API: the router answers 404 for every other path.
 *
 * There is no bearer key in front of it (GitHub and Stripe cannot send
 * one), so the handler refuses any binding without a `secret`, and every
 * hit must pass the binding's `verify` scheme. Every signed binding also
 * gets replay protection here: a delivery id already turned into a task
 * (`X-GitHub-Delivery`, `webhook-id`, Stripe event `id`) answers 200 and
 * runs nothing, and the timestamped schemes (Standard Webhooks, Stripe)
 * refuse a signature more than 5 minutes old.
 */
export function buildTunnelRouteTable(): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/api/webhooks/{name}",
      handler: createWebhookHandler({ requireSecret: true, dedupeDeliveries: true }),
      requiresAuth: false,
    },
  ];
}
