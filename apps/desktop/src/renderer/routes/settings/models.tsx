import { useEffect } from "react";
import { Check, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useModelStore } from "@/stores/model-store";

/**
 * Settings → Models. Read-only backend status (reachability, mode, latency,
 * context window, capabilities) plus the registered provider list with a
 * one-click "set active" action. Provider switch is global to the runtime.
 */
export function ModelsSettings(): React.ReactElement {
  const status = useModelStore((s) => s.status);
  const providers = useModelStore((s) => s.providers);
  const activeTextId = useModelStore((s) => s.activeTextId);
  const refresh = useModelStore((s) => s.refresh);
  const setActive = useModelStore((s) => s.setActive);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const caps = status?.capabilities;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Models</h1>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          onClick={() => void refresh()}
        >
          <RefreshCw className="size-4" />
          Refresh
        </Button>
      </div>

      <section className="mb-8 rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {status?.activeModelId?.trim() || "No model"}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-xs",
              status?.reachable
                ? "bg-green-500/15 text-green-600 dark:text-green-400"
                : "bg-red-500/15 text-red-600 dark:text-red-400",
            )}
          >
            {status?.reachable ? "reachable" : "unreachable"}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
          <StatRow label="Mode" value={status?.mode ?? "—"} />
          <StatRow
            label="Latency"
            value={status ? `${status.latencyMs}ms` : "—"}
          />
          <StatRow
            label="Context window"
            value={
              status?.contextWindow
                ? status.contextWindow.toLocaleString()
                : "—"
            }
          />
          <StatRow label="Vision" value={caps?.vision ? "yes" : "no"} />
          <StatRow label="Tool transport" value={caps?.toolTransport ?? "—"} />
          <StatRow
            label="Parallel tools"
            value={caps?.supportsParallelTools ? "yes" : "no"}
          />
          <StatRow
            label="Prompt cache"
            value={caps?.supportsPromptCache ? "yes" : "no"}
          />
          <StatRow label="Reasoning" value={caps?.reasoningFormat ?? "—"} />
        </dl>

        {status?.url ? (
          <p className="mt-3 truncate text-xs text-muted-foreground">
            {status.url}
          </p>
        ) : null}
        {status?.error ? (
          <p className="mt-1 text-xs text-red-500">{status.error}</p>
        ) : null}
      </section>

      <h2 className="mb-3 text-sm font-medium text-muted-foreground">
        Providers
      </h2>
      <div className="divide-y divide-border rounded-lg border border-border">
        {providers.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            No providers registered.
          </p>
        ) : (
          providers.map((p) => {
            const isActive = p.id === activeTextId;
            return (
              <div
                key={p.id}
                className="flex items-center gap-3 px-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{p.id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {p.kind}
                    {p.chatModel ? ` · ${p.chatModel}` : ""}
                    {p.capabilities?.contextWindow
                      ? ` · ${p.capabilities.contextWindow.toLocaleString()} ctx`
                      : ""}
                  </p>
                </div>
                {!p.hasApiKey && p.kind !== "llama-server" ? (
                  <span
                    className="shrink-0 text-xs text-amber-500"
                    title="No API key resolved"
                  >
                    no key
                  </span>
                ) : null}
                {isActive ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-primary">
                    <Check className="size-4" />
                    Active
                  </span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void setActive(p.id)}
                  >
                    Use
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}
