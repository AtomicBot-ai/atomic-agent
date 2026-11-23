import { afterEach, describe, expect, it } from "vitest";

import { en, type MessageKey } from "./en.js";
import { ru } from "./ru.js";
import {
  getUiLanguage,
  languageFromLocale,
  resolveUiLanguage,
  setUiLanguage,
  t,
} from "./index.js";

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

afterEach(() => setUiLanguage("en"));

describe("catalogs", () => {
  it("gives Russian exactly the English keys", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps the same {params} in every Russian string", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(ru[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it("has no empty string in either language", () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(en[key].trim(), key).not.toBe("");
      expect(ru[key].trim(), key).not.toBe("");
    }
  });
});

describe("t", () => {
  it("starts in English without anyone setting a language", () => {
    expect(getUiLanguage()).toBe("en");
    expect(t("onboarding.footer.quit")).toBe("ctrl+c quit");
  });

  it("fills {name} placeholders and leaves unknown ones as written", () => {
    expect(t("onboarding.footer.importDone", { quit: "Q" })).toBe("any key to start   Q");
    expect(t("onboarding.footer.importDone")).toBe("any key to start   {quit}");
    expect(t("onboarding.footer.importDone", { other: 1 })).toBe("any key to start   {quit}");
    expect(t("onboarding.footer.hfRef", { clear: "", quit: "q" })).toBe("enter look it up   esc back   q");
  });

  it("switches with the active language", () => {
    setUiLanguage("ru");
    expect(t("onboarding.subtitle.choose")).toBe("настройка · шаг 1 из 2");
    expect(t("onboarding.footer.importDone", { quit: "Q" })).toBe("любая клавиша, чтобы начать   Q");
    setUiLanguage("en");
    expect(t("onboarding.subtitle.choose")).toBe("setup · step 1 of 2");
  });

  it("falls back to English for a key a language leaves out", () => {
    const key = "onboarding.footer.quit" as const;
    const saved = ru[key];
    const mutable = ru as Record<MessageKey, string>;
    try {
      delete (mutable as Partial<Record<MessageKey, string>>)[key];
      setUiLanguage("ru");
      expect(t(key)).toBe(en[key]);
    } finally {
      mutable[key] = saved;
    }
  });
});

describe("languageFromLocale", () => {
  it("reads language tags and POSIX locales", () => {
    expect(languageFromLocale("ru")).toBe("ru");
    expect(languageFromLocale("ru_RU.UTF-8")).toBe("ru");
    expect(languageFromLocale("ru-RU")).toBe("ru");
    expect(languageFromLocale("RU_ru@euro")).toBe("ru");
    expect(languageFromLocale("en_US.UTF-8")).toBe("en");
  });

  it("gives null for anything unsupported", () => {
    for (const raw of ["C", "POSIX", "C.UTF-8", "de_DE.UTF-8", "", "  ", undefined, null]) {
      expect(languageFromLocale(raw), String(raw)).toBeNull();
    }
  });
});

describe("resolveUiLanguage", () => {
  it("prefers the config setting over the env var and the locale", () => {
    expect(resolveUiLanguage({
      setting: "en", env: { ATOMIC_AGENT_LANG: "ru", LANG: "ru_RU.UTF-8" },
    })).toBe("en");
    expect(resolveUiLanguage({
      setting: "ru", env: { ATOMIC_AGENT_LANG: "en", LANG: "en_US.UTF-8" },
    })).toBe("ru");
  });

  it("treats auto, unset and unknown settings as no setting", () => {
    for (const setting of ["auto", undefined, null, "de"]) {
      expect(resolveUiLanguage({ setting, env: { ATOMIC_AGENT_LANG: "ru" } }), String(setting)).toBe("ru");
    }
  });

  it("prefers ATOMIC_AGENT_LANG over the system locale", () => {
    expect(resolveUiLanguage({ env: { ATOMIC_AGENT_LANG: "en", LANG: "ru_RU.UTF-8" } })).toBe("en");
    expect(resolveUiLanguage({ env: { ATOMIC_AGENT_LANG: "ru", LANG: "en_US.UTF-8" } })).toBe("ru");
  });

  it("skips an unsupported ATOMIC_AGENT_LANG", () => {
    expect(resolveUiLanguage({ env: { ATOMIC_AGENT_LANG: "de", LANG: "ru_RU.UTF-8" } })).toBe("ru");
  });

  it("reads the locale in POSIX order: LC_ALL, LC_MESSAGES, LANG", () => {
    expect(resolveUiLanguage({ env: { LANG: "ru_RU.UTF-8" } })).toBe("ru");
    expect(resolveUiLanguage({ env: { LC_MESSAGES: "ru_RU.UTF-8", LANG: "en_US.UTF-8" } })).toBe("ru");
    expect(resolveUiLanguage({ env: { LC_ALL: "en_US.UTF-8", LC_MESSAGES: "ru_RU.UTF-8" } })).toBe("en");
    expect(resolveUiLanguage({ env: { LC_ALL: "C", LANG: "ru_RU.UTF-8" } })).toBe("en");
    expect(resolveUiLanguage({ env: { LC_ALL: "", LANG: "ru_RU.UTF-8" } })).toBe("ru");
  });

  it("falls back to English", () => {
    expect(resolveUiLanguage({ env: {} })).toBe("en");
    expect(resolveUiLanguage({ env: { LANG: "de_DE.UTF-8" } })).toBe("en");
  });
});
