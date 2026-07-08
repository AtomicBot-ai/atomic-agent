import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type FontSize = "14px" | "16px" | "18px" | "20px";
export type AccentColor = "neutral" | "blue" | "green" | "violet" | "rose";

export const FONT_SIZE_OPTIONS: { label: string; value: FontSize }[] = [
  { label: "Small", value: "14px" },
  { label: "Medium", value: "16px" },
  { label: "Large", value: "18px" },
  { label: "Extra Large", value: "20px" },
];

interface AccentPreset {
  name: string;
  value: AccentColor;
  /** Base oklch hue. `null` means neutral — restore the stylesheet defaults. */
  hue: number | null;
  /** Base chroma for the saturated (primary/ring) role. */
  chroma: number;
  /** Lightness for the saturated (primary/ring) role. */
  primaryL: number;
  swatch: string;
}

export const ACCENT_COLORS: AccentPreset[] = [
  { name: "Blue", value: "blue", hue: 255, chroma: 0.18, primaryL: 0.6, swatch: "oklch(0.6 0.18 255)" },
  { name: "Neutral", value: "neutral", hue: null, chroma: 0, primaryL: 0, swatch: "var(--foreground)" },
  { name: "Green", value: "green", hue: 150, chroma: 0.15, primaryL: 0.6, swatch: "oklch(0.6 0.15 150)" },
  { name: "Violet", value: "violet", hue: 290, chroma: 0.2, primaryL: 0.55, swatch: "oklch(0.55 0.2 290)" },
  { name: "Rose", value: "rose", hue: 15, chroma: 0.2, primaryL: 0.6, swatch: "oklch(0.6 0.2 15)" },
];

const DEFAULT_FONT_SIZE: FontSize = "16px";
const DEFAULT_ACCENT: AccentColor = "blue";
const DEFAULT_LANGUAGE = "en";

/**
 * Every CSS custom property the accent controls. Cleared before re-applying so
 * switching to "neutral" (or between colors) never leaves a stale override.
 */
const ACCENT_TOKENS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--accent",
  "--accent-foreground",
  "--sidebar",
  "--sidebar-primary",
  "--sidebar-accent",
  "--sidebar-accent-foreground",
  "--sidebar-ring",
] as const;

function applyFontSize(size: FontSize): void {
  document.documentElement.style.setProperty("--font-size-base", size);
}

const min = (a: number, b: number): number => (a < b ? a : b);

/**
 * Derive the full accent token set from a preset. The saturated hue drives
 * primary/ring; low-chroma tints of the same hue drive the accent/sidebar
 * surfaces so selection + hover states pick up the color everywhere without
 * turning the whole UI garish. Theme-aware (light vs dark lightness).
 */
function buildAccentVars(
  preset: AccentPreset,
  isDark: boolean,
): Record<string, string> {
  const h = preset.hue as number;
  const c = preset.chroma;
  const solid = `oklch(${preset.primaryL} ${c} ${h})`;
  if (isDark) {
    return {
      "--primary": solid,
      "--primary-foreground": "oklch(0.985 0 0)",
      "--ring": solid,
      "--sidebar-primary": solid,
      "--sidebar-ring": solid,
      "--accent": `oklch(0.32 ${min(c, 0.06)} ${h})`,
      "--accent-foreground": "oklch(0.985 0 0)",
      "--sidebar-accent": `oklch(0.34 ${min(c, 0.07)} ${h})`,
      "--sidebar-accent-foreground": "oklch(0.985 0 0)",
      "--sidebar": `oklch(0.26 ${min(c, 0.03)} ${h})`,
    };
  }
  return {
    "--primary": solid,
    "--primary-foreground": "oklch(0.985 0 0)",
    "--ring": solid,
    "--sidebar-primary": solid,
    "--sidebar-ring": solid,
    "--accent": `oklch(0.94 ${min(c, 0.05)} ${h})`,
    "--accent-foreground": `oklch(0.32 ${min(c, 0.1)} ${h})`,
    "--sidebar-accent": `oklch(0.9 ${min(c, 0.06)} ${h})`,
    "--sidebar-accent-foreground": `oklch(0.3 ${min(c, 0.1)} ${h})`,
    "--sidebar": `oklch(0.95 ${min(c, 0.03)} ${h})`,
  };
}

/**
 * Apply the accent token set. `isDark` should be passed explicitly by callers
 * that know the resolved theme (e.g. the `useTheme()` sync) — reading the
 * `.dark` class off the DOM races the theme toggle: `next-themes` may not have
 * rewritten the class yet when our effect fires. When omitted (color-pick /
 * initial mount) the DOM class is a safe fallback because the theme is stable.
 */
function applyAccent(value: AccentColor, isDark?: boolean): void {
  const preset = ACCENT_COLORS.find((c) => c.value === value);
  const root = document.documentElement;
  for (const token of ACCENT_TOKENS) {
    root.style.removeProperty(token);
  }
  if (!preset || preset.hue === null) return;
  const dark = isDark ?? root.classList.contains("dark");
  const vars = buildAccentVars(preset, dark);
  for (const [key, val] of Object.entries(vars)) {
    root.style.setProperty(key, val);
  }
}

interface SettingsState {
  fontSize: FontSize;
  accentColor: AccentColor;
  language: string;
  setFontSize: (size: FontSize) => void;
  setAccentColor: (color: AccentColor) => void;
  setLanguage: (language: string) => void;
}

/**
 * localStorage-backed replacement for Jan's `@tauri-apps/plugin-store`
 * interface settings. Font size and accent color are applied to the
 * document root both on mutation and on rehydrate.
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      fontSize: DEFAULT_FONT_SIZE,
      accentColor: DEFAULT_ACCENT,
      language: DEFAULT_LANGUAGE,
      setFontSize: (fontSize) => {
        applyFontSize(fontSize);
        set({ fontSize });
      },
      setAccentColor: (accentColor) => {
        applyAccent(accentColor);
        set({ accentColor });
      },
      setLanguage: (language) => set({ language }),
    }),
    {
      name: "atomic-agent:settings",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyFontSize(state.fontSize);
          applyAccent(state.accentColor);
        }
      },
    },
  ),
);

/**
 * Apply the current settings to the DOM. Safe to call on first mount when
 * there is nothing persisted yet (falls back to defaults).
 */
export function applySettingsToDom(): void {
  const { fontSize, accentColor } = useSettingsStore.getState();
  applyFontSize(fontSize);
  applyAccent(accentColor);
}

/**
 * Re-apply the current accent against the live theme. Called when the
 * light/dark class flips so the tinted surfaces switch lightness bands.
 * Pass `isDark` from the resolved theme to avoid racing the DOM class flip.
 */
export function reapplyAccent(isDark?: boolean): void {
  applyAccent(useSettingsStore.getState().accentColor, isDark);
}
