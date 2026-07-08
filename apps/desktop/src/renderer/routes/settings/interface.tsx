import { AccentColorPicker } from "@/containers/accent-color-picker";
import { FontSizeSwitcher } from "@/containers/font-size-switcher";
import { ThemeSwitcher } from "@/containers/theme-switcher";
import { LanguageSwitcher } from "@/containers/language-switcher";
import { useTranslation } from "@/i18n";

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-xs text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="w-48 shrink-0">{children}</div>
    </div>
  );
}

export function InterfaceSettings(): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-lg font-semibold">
        {t("settings:interface.title", { defaultValue: "Interface" })}
      </h1>

      <SettingRow
        title={t("settings:interface.theme", { defaultValue: "Theme" })}
        description={t("settings:interface.themeDesc", {
          defaultValue: "Light, dark, or follow the system",
        })}
      >
        <ThemeSwitcher />
      </SettingRow>

      <SettingRow
        title={t("settings:interface.accent", { defaultValue: "Accent color" })}
        description={t("settings:interface.accentDesc", {
          defaultValue: "Primary highlight color",
        })}
      >
        <div className="flex justify-end">
          <AccentColorPicker />
        </div>
      </SettingRow>

      <SettingRow
        title={t("settings:interface.fontSize", { defaultValue: "Font size" })}
        description={t("settings:interface.fontSizeDesc", {
          defaultValue: "Base text size",
        })}
      >
        <FontSizeSwitcher />
      </SettingRow>

      <SettingRow
        title={t("common:language", { defaultValue: "Language" })}
        description={t("common:changeLanguage", {
          defaultValue: "Interface language",
        })}
      >
        <LanguageSwitcher />
      </SettingRow>
    </div>
  );
}
