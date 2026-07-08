import React, { useCallback, useEffect } from "react";

import { useSettingsStore } from "@/lib/settings-store";
import i18next, { loadTranslations } from "./setup";
import { TranslationContext } from "./context";

/**
 * Bridges the settings-store language into the i18n runtime. When the
 * persisted language changes, the active locale is swapped and the provider
 * re-renders so consumers pick up the new translations.
 */
export const TranslationProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const language = useSettingsStore((s) => s.language);

  useEffect(() => {
    loadTranslations();
  }, []);

  useEffect(() => {
    if (language) i18next.changeLanguage(language);
  }, [language]);

  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => i18next.t(key, options),
    [],
  );

  return (
    <TranslationContext.Provider value={{ t: translate, i18n: i18next }}>
      {children}
    </TranslationContext.Provider>
  );
};

export default TranslationProvider;
