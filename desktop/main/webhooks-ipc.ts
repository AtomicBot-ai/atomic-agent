/**
 * ATO-445: what the renderer may ask of the agent's webhook routes
 * (Settings › Tasks › Webhooks). The renderer is not trusted with the
 * request shape: only these fields, in these forms, reach
 * `POST /api/webhooks` and `DELETE /api/webhooks/:name`. The agent
 * validates again; this keeps junk and oversized values off the wire.
 */

export const WEBHOOK_PRESETS = ["github", "stripe", "standard", "header"] as const;
export type WebhookPreset = (typeof WEBHOOK_PRESETS)[number];

const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TEMPLATE = 4000;
const MAX_SECRET = 512;

export function webhookNameOk(name: unknown): name is string {
  return typeof name === "string" && NAME.test(name) && name !== "__proto__";
}

export type CleanWebhookCreate =
  | { ok: true; body: { name: string; verify: WebhookPreset; userMessageTemplate: string; secret?: string } }
  | { ok: false; error: string };

export function cleanWebhookCreate(raw: unknown): CleanWebhookCreate {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid webhook" };
  const r = raw as Record<string, unknown>;
  if (!webhookNameOk(r.name)) return { ok: false, error: "The name can use letters, digits, - and _ (up to 64)." };
  const verify = r.verify ?? "header";
  if (typeof verify !== "string" || !(WEBHOOK_PRESETS as readonly string[]).includes(verify)) {
    return { ok: false, error: "Unknown signature preset." };
  }
  const template = typeof r.userMessageTemplate === "string" ? r.userMessageTemplate.trim() : "";
  if (!template) return { ok: false, error: "Write what the agent should do with each event." };
  if (template.length > MAX_TEMPLATE) return { ok: false, error: `The prompt is longer than ${MAX_TEMPLATE} characters.` };
  const secret = typeof r.secret === "string" ? r.secret.trim() : "";
  if (secret.length > MAX_SECRET) return { ok: false, error: "The secret is too long." };
  return {
    ok: true,
    body: { name: r.name, verify: verify as WebhookPreset, userMessageTemplate: template, ...(secret ? { secret } : {}) },
  };
}
