import { useRouter } from "@tanstack/react-router";
import { MessageCircle } from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Kbd } from "@/components/ui/kbd";
import { ThreadList } from "@/containers/thread-list";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { useSessionStore } from "@/stores/session-store";

/**
 * Floating left sidebar (shadcn `variant="floating"`): gradient card overlaid
 * on the canvas with rounded corners and a collapse toggle, matching Jan.
 * Holds the brand header, a "new chat" action, and the session thread list.
 * Settings now lives in the top panel, not here.
 */
export function AppSidebar(): React.ReactElement {
  const router = useRouter();
  const { t } = useTranslation();
  const isMac = window.windowControls?.platform === "darwin";
  const mod = isMac ? "⌘" : "Ctrl";

  const createChat = (): void => {
    // Open the New Chat draft — no backend session is created until the first
    // message is sent. Clear the active id so no thread stays highlighted.
    useSessionStore.getState().setActive(null);
    void router.navigate({ to: "/" });
  };

  return (
    <Sidebar variant="floating" collapsible="offcanvas">
      <SidebarHeader className={cn("drag-region", isMac && "pt-9")}>
        <div className="flex items-center gap-2">
          <img
            src="/images/logo.svg"
            alt="Atomic Agent"
            title="Atomic Agent"
            className="no-drag-region size-8 shrink-0 rounded-lg shadow-sm"
          />
          <span className="select-none font-studio text-base font-medium">
            Atomic Agent
          </span>
          <SidebarTrigger className="no-drag-region ml-auto" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={createChat}>
                <MessageCircle />
                <span className="flex-1">
                  {t("common:newChat", { defaultValue: "New Chat" })}
                </span>
                <Kbd>{mod}</Kbd>
                <Kbd>N</Kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="min-h-0 flex-1">
          <SidebarGroupLabel>
            {t("common:chats", { defaultValue: "Chats" })}
          </SidebarGroupLabel>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ThreadList />
          </div>
        </SidebarGroup>
      </SidebarContent>

      <SidebarRail />
    </Sidebar>
  );
}
