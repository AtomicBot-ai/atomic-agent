import { ChevronsUpDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSettingsStore } from "@/lib/settings-store";
import { cn } from "@/lib/utils";

/**
 * Language options mirror the locales shipped under `renderer/locales`. The
 * choice is persisted via the settings store, which drives `TranslationProvider`.
 */
export const LANGUAGE_OPTIONS: { label: string; value: string }[] = [
  { label: "English", value: "en" },
  { label: "Español", value: "es" },
  { label: "Français", value: "fr" },
  { label: "Bahasa", value: "id" },
  { label: "Polski", value: "pl" },
  { label: "Tiếng Việt", value: "vn" },
  { label: "简体中文", value: "zh-CN" },
  { label: "繁體中文", value: "zh-TW" },
  { label: "Deutsch", value: "de-DE" },
  { label: "Čeština", value: "cs" },
  { label: "Português (Brasil)", value: "pt-BR" },
  { label: "日本語", value: "ja" },
  { label: "Русский", value: "ru" },
];

export function LanguageSwitcher(): React.ReactElement {
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-between">
          {LANGUAGE_OPTIONS.find((item) => item.value === language)?.label ??
            "English"}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground ml-2" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {LANGUAGE_OPTIONS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            className={cn(
              "cursor-pointer my-0.5",
              language === item.value && "bg-secondary-foreground/8",
            )}
            onClick={() => setLanguage(item.value)}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
