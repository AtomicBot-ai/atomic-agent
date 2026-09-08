import type { AtomicMailService } from "../../atomic-mail/index.js";
import { getConfig } from "../../config/index.js";
import { IntegrationSecretError, type IntegrationField } from "../../integrations/index.js";

/**
 * The Atomic Mail half of the hub orchestrator. Its two inputs do
 * something the moment they are saved — an owner address gets a code
 * mailed to it, a code gets checked — so neither is a setting in the
 * plain sense, and the message says what happened rather than "saved".
 */

type Service = Pick<AtomicMailService, "register" | "sendCode" | "verifyCode" | "clearOwner" | "forget">;

/**
 * Runs *before* `writeFieldValue`. Returns the message to show, or
 * `null` when the field is an ordinary stored one (the API key).
 */
export async function applyAtomicMailField(
  service: Service,
  field: IntegrationField,
  value: string | null,
): Promise<string | null> {
  const trimmed = value === null ? null : value.trim();
  if (trimmed !== null) {
    if (trimmed.length === 0) throw new IntegrationSecretError(`${field.label} is empty`);
    const invalid = field.validate?.(trimmed);
    if (invalid !== undefined) throw new IntegrationSecretError(invalid);
  }
  if (field.key === "ownerEmail") {
    if (trimmed === null) {
      service.clearOwner();
      return "Your e-mail cleared";
    }
    const { expiresAt } = await service.sendCode(trimmed);
    return `Code sent to ${trimmed} — valid until ${new Date(expiresAt).toLocaleTimeString()}; press e on Verification code`;
  }
  if (field.key === "verificationCode") {
    if (trimmed === null) return "Nothing to clear";
    const result = service.verifyCode(trimmed);
    if (!result.ok) throw new IntegrationSecretError(result.reason);
    return `${result.email} verified — downloads can e-mail you now`;
  }
  return null;
}

export async function runAtomicMailAction(
  service: Service,
  actionId: string,
  registration: { inFlight: Promise<void> | null },
  hooks: { onSettled: (message?: string, error?: string) => void },
): Promise<string> {
  if (actionId === "register") {
    // A proof-of-work is seconds to a minute of CPU. Fire-and-forget
    // like Telegram pairing: the outcome lands as its own message. One
    // at a time — a second inbox would orphan the first one's key,
    // which the service hands out exactly once.
    if (registration.inFlight) return "Still registering — the address arrives in a moment";
    registration.inFlight = service
      .register()
      .then(({ address }) => hooks.onSettled(`Inbox ready: ${address} — now press e on Your e-mail`))
      .catch((err: unknown) =>
        hooks.onSettled(undefined, `Registration failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        registration.inFlight = null;
      });
    return "Registering the agent's inbox — solving a proof-of-work…";
  }
  if (actionId === "resend") {
    const email = getConfig().atomicMail.ownerEmail;
    if (!email) throw new Error("no e-mail to send a code to — press e on Your e-mail first");
    const { expiresAt } = await service.sendCode(email);
    return `Code sent to ${email} — valid until ${new Date(expiresAt).toLocaleTimeString()}; press e on Verification code`;
  }
  if (actionId === "forget") {
    service.forget();
    return "Inbox forgotten on this machine";
  }
  throw new Error(`unknown action ${actionId} for atomic-mail`);
}
