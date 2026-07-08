import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { ModelSwitcher } from "@/containers/model-switcher";
import { WindowControls } from "@/containers/window-controls";
import { cn } from "@/lib/utils";

/**
 * Top panel for chat views. Doubles as the window drag region (there is no
 * separate title bar). Hosts the model switcher pill, a Settings entry, and —
 * on Windows/Linux — the custom window controls. A sidebar toggle appears here
 * only while the floating sidebar is collapsed so it can be reopened.
 */
export function ChatHeader(): React.ReactElement {
  const { state } = useSidebar();
  const isMac = window.windowControls?.platform === "darwin";
  const collapsed = state === "collapsed";

  return (
    <div
      className={cn(
        "drag-region flex h-12 shrink-0 items-center gap-2 px-3",
        isMac && collapsed && "pl-20",
      )}
    >
      {collapsed ? <SidebarTrigger className="no-drag-region" /> : null}

      <ModelSwitcher />

      <div className="no-drag-region ml-auto flex items-center gap-1">
        <Link to="/settings/interface">
          <Button variant="ghost" size="icon" title="Settings">
            <Settings className="size-4" />
          </Button>
        </Link>
        <WindowControls />
      </div>
    </div>
  );
}
