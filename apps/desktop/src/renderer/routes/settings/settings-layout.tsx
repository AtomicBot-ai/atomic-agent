import { Link, Outlet } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { WindowControls } from "@/containers/window-controls";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";

const SETTINGS_NAV = [
  { to: "/settings/interface", key: "common:interface", fallback: "Interface" },
  { to: "/settings/models", key: "common:models", fallback: "Models" },
  {
    to: "/settings/shortcuts",
    key: "common:keyboardShortcuts",
    fallback: "Keyboard Shortcuts",
  },
] as const;

export function SettingsLayout(): React.ReactElement {
  const { t } = useTranslation();
  const { state } = useSidebar();
  const isMac = window.windowControls?.platform === "darwin";
  const collapsed = state === "collapsed";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div
        className={cn(
          "drag-region flex h-12 shrink-0 items-center gap-2 px-3",
          isMac && collapsed && "pl-20",
        )}
      >
        {collapsed ? <SidebarTrigger className="no-drag-region" /> : null}
        <Link to="/" className="no-drag-region">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="size-4" />
            {t("common:back", { defaultValue: "Back to chat" })}
          </Button>
        </Link>
        <div className="no-drag-region ml-auto">
          <WindowControls />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav className="flex w-52 shrink-0 flex-col gap-1 border-r border-border p-3">
          {SETTINGS_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="block"
              activeOptions={{ exact: true }}
            >
              {({ isActive }) => (
                <span
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {t(item.key, { defaultValue: item.fallback })}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
