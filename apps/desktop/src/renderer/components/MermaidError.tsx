import { memo } from "react";

interface MermaidErrorComponentProps {
  error: string;
  chart: string;
  retry: () => void;
  messageId?: string;
}

/**
 * Fallback shown when a mermaid diagram in a markdown reply fails to render.
 */
function MermaidErrorComponent({ error }: MermaidErrorComponentProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 p-6">
      <p className="text-center text-sm text-muted-foreground">
        Diagram error detected
      </p>
      <p className="mt-1 text-center text-xs text-muted-foreground/60">
        {error}
      </p>
    </div>
  );
}

export const MermaidError = memo(MermaidErrorComponent);
