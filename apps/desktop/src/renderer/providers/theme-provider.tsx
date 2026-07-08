import { useEffect } from "react";
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";

import { applySettingsToDom, reapplyAccent } from "@/lib/settings-store";

/**
 * Re-applies the accent tokens whenever the resolved light/dark theme flips,
 * so the tinted accent/sidebar surfaces switch to the correct lightness band.
 * Must live inside `NextThemesProvider` to read `useTheme`.
 */
function AccentThemeSync(): null {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    // `resolvedTheme` is `undefined` until next-themes mounts; the initial
    // application is handled by `applySettingsToDom` off the DOM class. Once
    // resolved, thread it explicitly so the correct lightness band is used.
    if (!resolvedTheme) return;
    reapplyAccent(resolvedTheme === "dark");
  }, [resolvedTheme]);
  return null;
}

/**
 * Root theme + settings provider. `next-themes` owns the light/dark/system
 * class on <html>; the interface settings store applies font-size and
 * accent-color CSS variables once the tree mounts.
 */
export function ThemeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  useEffect(() => {
    applySettingsToDom();
  }, []);

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <AccentThemeSync />
      {children}
    </NextThemesProvider>
  );
}
