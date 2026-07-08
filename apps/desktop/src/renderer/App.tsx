import { RouterProvider } from "@tanstack/react-router";

import { ThemeProvider } from "./providers/theme-provider";
import { TranslationProvider } from "./i18n";
import { router } from "./app/router";
import { Toaster } from "./components/ui/sonner";

export function App(): React.ReactElement {
  return (
    <ThemeProvider>
      <TranslationProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TranslationProvider>
    </ThemeProvider>
  );
}
