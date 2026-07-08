/**
 * Lightweight i18n runtime ported from Atomic-Chat (Jan). Locale JSON files
 * are discovered via `import.meta.glob`, so adding a namespace or language is
 * a pure file drop under `../locales/<lang>/<namespace>.json`. Language
 * persistence is owned by `lib/settings-store` (Zustand + localStorage); this
 * module only reads the stored value on cold start.
 */

const SETTINGS_STORAGE_KEY = "atomic-agent:settings";

export interface TranslationResources {
  [language: string]: {
    [namespace: string]: {
      [key: string]: string;
    };
  };
}

export interface I18nInstance {
  language: string;
  fallbackLng: string;
  resources: TranslationResources;
  namespaces: string[];
  defaultNS: string;
  changeLanguage: (lng: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

let i18nInstance: I18nInstance;

const localeFiles = import.meta.glob("../locales/**/*.json", { eager: true });

const resources: TranslationResources = {};
const namespaces: string[] = [];

Object.entries(localeFiles).forEach(([path, module]) => {
  const match = path.match(/\.\.\/locales\/([^/]+)\/([^/]+)\.json/);
  if (!match) return;
  const [, language, namespace] = match;
  if (!language || !namespace) return;

  if (!resources[language]) resources[language] = {};
  if (!namespaces.includes(namespace)) namespaces.push(namespace);

  resources[language][namespace] =
    (module as { default: { [key: string]: string } }).default ??
    (module as { [key: string]: string });
});

function getStoredLanguage(): string {
  try {
    const stored = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed?.state?.language || "en";
  } catch {
    return "en";
  }
}

function getNestedValue(
  obj: Record<string, unknown> | undefined,
  path: string,
): string | undefined {
  if (!obj) return undefined;
  return path.split(".").reduce<unknown>((current, key) => {
    return current &&
      typeof current === "object" &&
      current !== null &&
      key in current
      ? (current as Record<string, unknown>)[key]
      : undefined;
  }, obj) as string | undefined;
}

function translate(key: string, options: Record<string, unknown> = {}): string {
  const { language, fallbackLng, resources: res, defaultNS } = i18nInstance;

  let namespace = defaultNS;
  let translationKey = key;
  if (key.includes(":")) {
    const parts = key.split(":");
    namespace = parts[0]!;
    translationKey = parts[1]!;
  }

  let translation = getNestedValue(res[language]?.[namespace], translationKey);
  if (translation === undefined && language !== fallbackLng) {
    translation = getNestedValue(res[fallbackLng]?.[namespace], translationKey);
  }

  if (translation === undefined) {
    const fallback = options?.defaultValue;
    if (typeof fallback === "string") {
      translation = fallback;
    } else {
      return key;
    }
  }

  if (typeof translation === "string" && options) {
    return translation.replace(/\{\{(\w+)\}\}/g, (matched, variable) =>
      options[variable] !== undefined ? String(options[variable]) : matched,
    );
  }

  return String(translation);
}

function changeLanguage(lng: string): void {
  if (i18nInstance && resources[lng]) {
    i18nInstance.language = lng;
  }
}

function initI18n(): I18nInstance {
  i18nInstance = {
    language: getStoredLanguage(),
    fallbackLng: "en",
    resources,
    namespaces,
    defaultNS: "common",
    changeLanguage,
    t: translate,
  };
  return i18nInstance;
}

export const loadTranslations = (): void => {
  // Translations are eagerly loaded via import.meta.glob; kept for API parity.
};

const i18n = initI18n();

export default i18n;
