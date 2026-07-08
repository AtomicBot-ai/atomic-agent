import { CloudOff } from "lucide-react";

import { useSessionStore } from "@/stores/session-store";

/**
 * Top-of-chat banner surfaced when llama-server is unreachable or the
 * sidecar process failed to boot.
 */
export function LlmBanner(): React.ReactElement | null {
  const llmUnavailable = useSessionStore((s) => s.llmUnavailable);
  const bootError = useSessionStore((s) => s.bootError);

  if (bootError) {
    return (
      <Banner title="Sidecar unavailable" detail={bootError} />
    );
  }
  if (llmUnavailable) {
    return (
      <Banner
        title={`LLM unavailable · ${llmUnavailable.mode}`}
        detail={llmUnavailable.hint || llmUnavailable.error || llmUnavailable.url}
      />
    );
  }
  return null;
}

function Banner({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
      <CloudOff className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium text-destructive">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
