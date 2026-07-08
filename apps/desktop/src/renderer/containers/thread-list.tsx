import { useRouter } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { removeSession } from "@/lib/chat-actions";
import { useSessionStore } from "@/stores/session-store";

/**
 * Session thread list backed by `session.list`. Selecting a row navigates to
 * its route; the trash action deletes the session via the sidecar.
 */
export function ThreadList(): React.ReactElement {
  const router = useRouter();
  const order = useSessionStore((s) => s.order);
  const entries = useSessionStore((s) => s.entries);
  const activeId = useSessionStore((s) => s.activeId);

  if (order.length === 0) {
    return (
      <p className="px-2 py-4 text-xs text-muted-foreground">No chats yet.</p>
    );
  }

  const open = (id: string): void => {
    useSessionStore.getState().setActive(id);
    void router.navigate({
      to: "/thread/$sessionId",
      params: { sessionId: id },
    });
  };

  const remove = async (id: string): Promise<void> => {
    await removeSession(id);
    const next = useSessionStore.getState().activeId;
    if (next) open(next);
    else void router.navigate({ to: "/" });
  };

  return (
    <ul className="flex flex-col gap-0.5 py-1">
      {order.map((id) => {
        const summary = entries[id]?.summary;
        if (!summary) return null;
        const label = summary.title?.trim() || "New chat";
        return (
          <li key={id}>
            <div
              className={cn(
                "group/thread flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                id === activeId
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/50",
              )}
            >
              <button
                type="button"
                onClick={() => open(id)}
                className="min-w-0 flex-1 truncate text-left"
                title={label}
              >
                {label}
              </button>
              <Button
                size="icon-sm"
                variant="ghost"
                title="Delete chat"
                className="opacity-0 group-hover/thread:opacity-100"
                onClick={() => void remove(id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
