import { ChevronDownIcon, Loader2, WrenchIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, memo, useContext, useMemo, useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";

/**
 * Tool-call lifecycle status, projected from the sidecar's tool result. Maps
 * to Jan's `ToolUIPart['state']` — `running` == input-streaming/available,
 * `ok` == output-available, `error` == output-error/denied.
 */
export type ToolStatus = "running" | "ok" | "error";

type ToolContextValue = { isOpen: boolean };
const ToolContext = createContext<ToolContextValue | null>(null);

function useTool(): ToolContextValue {
  const context = useContext(ToolContext);
  if (!context) throw new Error("Tool components must be used within Tool");
  return context;
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  defaultOpen?: boolean;
};

/**
 * Collapsible tool-call panel, ported from Jan's `Tool` ai-element and adapted
 * to the runtime's `ToolStep` model (no AI-SDK `ToolUIPart` dependency).
 */
export const Tool = memo(
  ({ className, defaultOpen = false, children, ...props }: ToolProps) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    const value = useMemo(() => ({ isOpen }), [isOpen]);
    return (
      <ToolContext.Provider value={value}>
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={setIsOpen}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ToolContext.Provider>
    );
  },
);
Tool.displayName = "Tool";

function statusText(status: ToolStatus, name: string): string {
  if (status === "running") return `Running ${name}`;
  if (status === "error") return `${name} failed`;
  return `Used ${name}`;
}

export type ToolHeaderProps = {
  name: string;
  status: ToolStatus;
  className?: string;
};

export const ToolHeader = memo(
  ({ name, status, className }: ToolHeaderProps) => {
    const { isOpen } = useTool();
    const running = status === "running";
    const Icon = running ? Loader2 : WrenchIcon;
    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <Icon
          className={cn(
            "size-4 shrink-0",
            running && "animate-spin",
            status === "error" && "text-destructive",
          )}
        />
        <span className="shrink-0">{statusText(status, "")}</span>
        <span className="truncate font-mono text-xs">{name}</span>
        <ChevronDownIcon
          className={cn(
            "ml-auto size-4 shrink-0 transition-transform",
            isOpen ? "rotate-180" : "rotate-0",
          )}
        />
      </CollapsibleTrigger>
    );
  },
);
ToolHeader.displayName = "ToolHeader";

export const ToolContent = memo(
  ({ className, children, ...props }: ComponentProps<typeof CollapsibleContent>) => (
    <CollapsibleContent
      className={cn(
        "relative mt-2 text-sm",
        "text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2",
        className,
      )}
      {...props}
    >
      <div className="ml-2 flex flex-col gap-3 border-l-2 border-dotted pl-4">
        {children}
      </div>
    </CollapsibleContent>
  ),
);
ToolContent.displayName = "ToolContent";

export type ToolInputProps = { input: unknown };

export const ToolInput = memo(({ input }: ToolInputProps) => {
  const json = useMemo(() => {
    try {
      return JSON.stringify(input, null, 2);
    } catch {
      return String(input);
    }
  }, [input]);
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Parameters
      </h4>
      <div className="max-h-40 overflow-auto rounded-md border">
        <CodeBlock code={json} language="json" />
      </div>
    </div>
  );
});
ToolInput.displayName = "ToolInput";

export type ToolOutputProps = { summary: string; error?: boolean };

export const ToolOutput = memo(({ summary, error }: ToolOutputProps) => (
  <div className="space-y-2">
    <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {error ? "Error" : "Result"}
    </h4>
    <div
      className={cn(
        "max-h-40 overflow-auto whitespace-pre-wrap rounded-md border p-2 text-xs",
        error && "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {summary}
    </div>
  </div>
));
ToolOutput.displayName = "ToolOutput";
