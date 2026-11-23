import { en, type MessageKey } from "./en.js";
import { ru } from "./ru.js";

/**
 * Interface languages (ATO-571). A small catalog of our own instead of a
 * library: English (`en.ts`) is complete and is the fallback for any key
 * another language leaves out; each other language is one flat file with
 * the same keys.
 *
 * The active language is a module singleton, like the active theme: the
 * TUI resolves it once at start-up (`setUiLanguage(resolveUiLanguage(...))`)
 * before the first render. Until then, and in every test that does not set
 * it, the language is English, so nothing depends on the machine's locale.
 */
export type { MessageKey } from "./en.js";

export type UiLanguage = "en" | "ru";
export const SUPPORTED_UI_LANGUAGES: readonly UiLanguage[] = ["en", "ru"];

const CATALOGS: Readonly<Record<UiLanguage, Readonly<Partial<Record<MessageKey, string>>>>> = {
  en,
  ru,
};

let active: UiLanguage = "en";

export function setUiLanguage(language: UiLanguage): void {
  active = language;
}

export function getUiLanguage(): UiLanguage {
  return active;
}

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * The text for `key` in the active language, with `{name}` replaced by
 * `params.name`. A key the language does not have falls back to English;
 * a placeholder without a value is left as written.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[active][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

/**
 * A supported language out of a language tag or a POSIX locale:
 * `ru`, `ru-RU`, `ru_RU.UTF-8` and `ru_RU@euro` all give `ru`. Anything
 * else (`C`, `POSIX`, `de_DE`, empty) gives null.
 */
export function languageFromLocale(raw: string | undefined | null): UiLanguage | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().split(/[._@-]/, 1)[0] ?? "";
  return (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(base) ? (base as UiLanguage) : null;
}

/**
 * Which language to show, in this order:
 *
 * 1. `tui.language` in config.json, when it names a language (not `auto`);
 * 2. `ATOMIC_AGENT_LANG`, when it names a supported one;
 * 3. the system locale: the first of `LC_ALL`, `LC_MESSAGES`, `LANG` that
 *    is set, as POSIX reads them (`LC_ALL=C` means English even when
 *    `LANG` says otherwise);
 * 4. English.
 */
export function resolveUiLanguage(
  options: { setting?: string | null; env?: NodeJS.ProcessEnv } = {},
): UiLanguage {
  const fromSetting = options.setting === "auto" ? null : languageFromLocale(options.setting);
  if (fromSetting) return fromSetting;
  const env = options.env ?? process.env;
  const fromEnv = languageFromLocale(env["ATOMIC_AGENT_LANG"]);
  if (fromEnv) return fromEnv;
  const locale = [env["LC_ALL"], env["LC_MESSAGES"], env["LANG"]].find(
    (value) => value !== undefined && value.trim() !== "",
  );
  return languageFromLocale(locale) ?? "en";
}
