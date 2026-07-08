import { Outlet } from "@tanstack/react-router";

import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/containers/app-sidebar";
import { useAgentController } from "@/use-agent-chat";

/**
 * Root shell modeled after Jan: a floating sidebar overlaid on a neutral
 * canvas plus a borderless content inset. There is no separate OS-style title
 * bar — window dragging is handled by the per-view top panels (`drag-region`).
 */
export function RootLayout(): React.ReactElement {
  useAgentController();
  return (
    <div className="relative h-svh w-screen bg-neutral-50 dark:bg-background">
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="h-svh overflow-hidden bg-transparent">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
