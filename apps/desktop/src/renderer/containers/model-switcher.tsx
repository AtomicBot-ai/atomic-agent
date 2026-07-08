import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Cpu, Settings2 } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useModelStore } from "@/stores/model-store";

/**
 * Clickable model pill in the top bar. Shows the active model + backend
 * reachability, and opens a popover to hot-swap the active LLM provider
 * (`provider.setActive`, applied globally to the runtime — not per session).
 */
export function ModelSwitcher(): React.ReactElement {
  const status = useModelStore((s) => s.status);
  const providers = useModelStore((s) => s.providers);
  const activeTextId = useModelStore((s) => s.activeTextId);
  const refresh = useModelStore((s) => s.refresh);
  const setActive = useModelStore((s) => s.setActive);
  const [open, setOpen] = useState(false);

  const label = status?.activeModelId?.trim() || "No model";
  const reachable = status?.reachable ?? false;

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) void refresh();
  };

  const choose = (id: string): void => {
    if (id !== activeTextId) void setActive(id);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className="no-drag-region inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:bg-accent/60"
        title="Switch model / provider"
      >
        <Cpu className="size-4 shrink-0 text-muted-foreground" />
        <span className="max-w-56 truncate">{label}</span>
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            reachable ? "bg-green-500" : "bg-red-500",
          )}
        />
      </PopoverTrigger>

      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{label}</span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs",
                reachable
                  ? "bg-green-500/15 text-green-600 dark:text-green-400"
                  : "bg-red-500/15 text-red-600 dark:text-red-400",
              )}
            >
              {reachable ? "reachable" : "unreachable"}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {status
              ? `${status.mode} · ${status.latencyMs}ms · ${status.url}`
              : "Loading backend status…"}
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {providers.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No providers registered.
            </p>
          ) : (
            providers.map((p) => {
              const isActive = p.id === activeTextId;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => choose(p.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/60",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{p.id}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {p.kind}
                      {p.chatModel ? ` · ${p.chatModel}` : ""}
                    </span>
                  </span>
                  {!p.hasApiKey && p.kind !== "llama-server" ? (
                    <span
                      className="shrink-0 text-xs text-amber-500"
                      title="No API key resolved"
                    >
                      no key
                    </span>
                  ) : null}
                  {isActive ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        <div className="border-t border-border p-1">
          <Link
            to="/settings/models"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <Settings2 className="size-4" />
            Manage models
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
