import { useEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Custom window controls for the frameless BrowserWindow. On macOS the
 * native traffic lights stay visible (`titleBarStyle: hiddenInset`), so we
 * render nothing there and only reserve drag space in the title bar. On
 * Windows/Linux we draw min/maximize/close buttons wired to `win.*` IPC.
 */
export function WindowControls(): React.ReactElement | null {
  const [maximized, setMaximized] = useState(false);
  const isMac = window.windowControls?.platform === "darwin";

  useEffect(() => {
    if (isMac) return;
    let active = true;
    void window.windowControls.isMaximized().then((value) => {
      if (active) setMaximized(value);
    });
    const unsubscribe = window.windowControls.onMaximizeChange(setMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isMac]);

  if (isMac) return null;

  return (
    <div className="flex items-center no-drag-region">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => window.windowControls.minimize()}
        className="flex h-8 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => window.windowControls.toggleMaximize()}
        className="flex h-8 w-11 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => window.windowControls.close()}
        className={cn(
          "flex h-8 w-11 items-center justify-center text-muted-foreground",
          "hover:bg-destructive hover:text-white",
        )}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
