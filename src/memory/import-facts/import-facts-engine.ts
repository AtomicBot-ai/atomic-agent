/**
 * ATO-1617 decision (Nadya, 17.11.2026, option A): which model may read
 * a chat export.
 *
 * - By default the LOCAL model reads it. Nothing leaves the machine.
 * - A cloud model only behind its own explicit checkbox, shown with
 *   {@link IMPORT_FACTS_CLOUD_WARNING}. The caller passes the person's
 *   answer as `cloudConsent: true`; anything else refuses before a
 *   single message is sent.
 *
 * The consent is per run: it is not stored and not read from config, so
 * a setting flipped once can never send a later export by itself.
 */
export type ImportFactsEngine =
  | { kind: "local" }
  | {
      kind: "cloud";
      /** Provider id as the UI names it (e.g. "openrouter"); for the warning and counts only. */
      provider: string;
      /** The person ticked the cloud checkbox for THIS run. */
      cloudConsent: boolean;
    };

export const IMPORT_FACTS_DEFAULT_ENGINE: ImportFactsEngine = { kind: "local" };

/** Text for the cloud checkbox. English: shown in the UI as is. */
export const IMPORT_FACTS_CLOUD_WARNING =
  "Use a cloud model instead of the local one. The text of your chats will be sent to the provider you picked.";

export class ImportFactsConsentError extends Error {
  constructor(provider: string) {
    super(
      `a cloud model (${provider}) needs the person's explicit consent for this import; nothing was sent`,
    );
    this.name = "ImportFactsConsentError";
  }
}

/** Throws {@link ImportFactsConsentError} for a cloud engine without consent. */
export function assertImportFactsEngineAllowed(engine: ImportFactsEngine): void {
  if (engine.kind === "local") return;
  if (engine.cloudConsent !== true) throw new ImportFactsConsentError(engine.provider);
}
