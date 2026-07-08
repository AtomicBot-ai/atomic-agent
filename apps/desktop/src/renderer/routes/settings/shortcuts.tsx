import { Kbd } from "@/components/ui/kbd";
import { useTranslation } from "@/i18n";

interface Shortcut {
  key: string;
  fallback: string;
  keys: string[];
}

const SHORTCUTS: Shortcut[] = [
  { key: "settings:shortcuts.sendMessage", fallback: "Send message", keys: ["Enter"] },
  { key: "settings:shortcuts.newLine", fallback: "New line", keys: ["Shift", "Enter"] },
  { key: "settings:shortcuts.newChat", fallback: "New chat", keys: ["Mod", "N"] },
  { key: "common:cancel", fallback: "Cancel current turn", keys: ["Esc"] },
  { key: "settings:shortcuts.goToSettings", fallback: "Open settings", keys: ["Mod", ","] },
];

export function ShortcutsSettings(): React.ReactElement {
  const { t } = useTranslation();
  const isMac = window.windowControls?.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-lg font-semibold">
        {t("common:keyboardShortcuts", { defaultValue: "Keyboard Shortcuts" })}
      </h1>
      <div className="divide-y divide-border">
        {SHORTCUTS.map((shortcut) => (
          <div
            key={shortcut.fallback}
            className="flex items-center justify-between py-3"
          >
            <span className="text-sm">
              {t(shortcut.key, { defaultValue: shortcut.fallback })}
            </span>
            <div className="flex items-center gap-1">
              {shortcut.keys.map((key) => (
                <Kbd key={key}>{key === "Mod" ? mod : key}</Kbd>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
