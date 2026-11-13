import { randomBytes } from "node:crypto";

import {
  ConfigValidationError,
  ensureUserConfigFileSync,
  getConfig,
  parseUserConfigFile,
  resetConfigCache,
} from "../config/index.js";
import type { WebhookConfig } from "../config/index.js";
import {
  isSafeConfigPath,
  readRawConfigTree,
  writeRawUserConfigFileSync,
} from "../config/config-paths.js";
import {
  isWebhookVerifyScheme,
  WEBHOOK_VERIFY_SCHEMES,
  type WebhookVerifyScheme,
} from "../config/webhook-config.js";

import { openaiError } from "./openai-errors.js";
import {
  readJsonBody,
  sendError,
  sendJson,
  type HttpHandler,
} from "./request-context.js";
import { webhookListItem, webhookPublicBase } from "./route-webhooks-list.js";

/**
 * ATO-445: manage the `webhooks` block from the desktop without editing
 * `config.json` by hand. Listing is `GET /api/webhooks` (ATO-625,
 * `route-webhooks-list.ts`); this module adds the writes:
 *
 *  - `POST   /api/webhooks`        — `{ name, verify?, userMessageTemplate,
 *    secret?, events?, sessionMode? }`: add a route. `verify` is one of the
 *    binding values from ATO-438/ATO-625 (`secret`, `github`,
 *    `standard-webhooks`, `stripe`; default `secret`). A secret is
 *    generated unless one is given (Stripe makes its own signing secret, so
 *    `stripe` needs it pasted). The reply carries the secret once; nothing
 *    reads it back later.
 *  - `DELETE /api/webhooks/{name}` — remove a route and its persistent session mapping
 *
 * Writes go through the same raw-tree read, full revalidation and atomic
 * write as `PATCH /api/config`, and the running agent's webhook map is
 * updated in place, so a new route answers without a restart.
 *
 * Outside senders (GitHub, Stripe) never reach the main API: it stays on
 * loopback behind its bearer key. They come in only through the webhook
 * tunnel listener (ATO-625), signed with the route's own secret. Nothing
 * here changes where the main API listens (see the admin test).
 */

/** A fresh secret in the shape the preset's sender expects. */
export function generateWebhookSecret(verify: WebhookVerifyScheme): string {
  if (verify === "standard-webhooks") return `whsec_${randomBytes(24).toString("base64")}`;
  return randomBytes(32).toString("hex");
}

export function createCreateWebhookHandler(): HttpHandler {
  return async (req, res, ctx) => {
    let body: unknown;
    try {
      body = await readJsonBody<unknown>(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 400, openaiError(`Invalid JSON: ${message}`));
      return;
    }
    if (!isPlainObject(body)) {
      sendError(res, 400, openaiError("body must be a JSON object"));
      return;
    }
    const name = body.name;
    if (typeof name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !isSafeConfigPath(name) || name === "__proto__") {
      sendError(res, 400, openaiError("name must be 1-64 letters, digits, - or _", "invalid_request_error", "name"));
      return;
    }
    const verify = body.verify ?? "secret";
    if (!isWebhookVerifyScheme(verify)) {
      sendError(res, 400, openaiError(`verify must be one of ${WEBHOOK_VERIFY_SCHEMES.join(", ")}`, "invalid_request_error", "verify"));
      return;
    }
    let secret: string;
    if (body.secret !== undefined && body.secret !== null && body.secret !== "") {
      if (typeof body.secret !== "string" || body.secret.trim().length === 0) {
        sendError(res, 400, openaiError("secret must be a non-empty string", "invalid_request_error", "secret"));
        return;
      }
      secret = body.secret.trim();
    } else if (verify === "stripe") {
      sendError(res, 400, openaiError("Stripe makes the signing secret: paste the whsec_… value Stripe shows for this endpoint", "invalid_request_error", "secret"));
      return;
    } else {
      secret = generateWebhookSecret(verify);
    }
    const entry: Record<string, unknown> = {
      userMessageTemplate: body.userMessageTemplate,
      secret,
      ...(verify !== "secret" ? { verify } : {}),
      // Checked by the config parser below (non-empty names, signed schemes only).
      ...(body.events !== undefined && body.events !== null ? { events: body.events } : {}),
      ...(body.sessionMode !== undefined ? { sessionMode: body.sessionMode } : {}),
    };

    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const tree = readRawConfigTree(path);
    const current = isPlainObject(tree.webhooks) ? tree.webhooks : {};
    if (Object.hasOwn(current, name)) {
      sendError(res, 409, openaiError(`webhook already exists: ${name}`, "invalid_request_error", "name"));
      return;
    }
    tree.webhooks = { ...current, [name]: entry };
    let parsed: WebhookConfig | undefined;
    try {
      parsed = parseUserConfigFile(tree).webhooks[name];
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    if (!parsed) {
      sendError(res, 500, openaiError("webhook did not survive validation"));
      return;
    }
    writeRawUserConfigFileSync(path, tree);
    resetConfigCache();
    ctx.runtime.config.webhooks[name] = parsed;
    sendJson(res, 201, {
      webhook: webhookListItem(name, parsed, true, webhookPublicBase()),
      secret,
    });
  };
}

export function createDeleteWebhookHandler(): HttpHandler {
  return async (_req, res, ctx) => {
    const name = ctx.params.name;
    if (!name || !isSafeConfigPath(name)) {
      sendError(res, 400, openaiError("webhook name is required"));
      return;
    }
    const path = getConfig().paths.userConfigFile;
    ensureUserConfigFileSync(path);
    const tree = readRawConfigTree(path);
    const current = isPlainObject(tree.webhooks) ? { ...tree.webhooks } : {};
    if (!Object.hasOwn(current, name)) {
      sendError(res, 404, openaiError(`webhook not found: ${name}`));
      return;
    }
    delete current[name];
    tree.webhooks = current;
    try {
      parseUserConfigFile(tree);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        sendError(res, 400, openaiError(err.message));
        return;
      }
      throw err;
    }
    writeRawUserConfigFileSync(path, tree);
    resetConfigCache();
    delete ctx.runtime.config.webhooks[name];
    ctx.runtime.webhookSessionStore.delete(name);
    sendJson(res, 200, { deleted: name });
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
