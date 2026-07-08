import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { resolveApproval } from "@/lib/chat-actions";
import { useSessionStore } from "@/stores/session-store";

interface ApprovalPromptProps {
  sessionId: string;
}

/**
 * Inline approval bar shown above the composer when the active session has a
 * pending tool-approval request.
 */
export function ApprovalPrompt({
  sessionId,
}: ApprovalPromptProps): React.ReactElement | null {
  const pending = useSessionStore((s) => s.pendingApproval);
  if (!pending || pending.sessionId !== sessionId) return null;

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <div className="flex items-center gap-2 font-medium">
          <ShieldAlert className="size-4 text-amber-500" />
          Approval required · <span className="font-mono">{pending.tool}</span>
        </div>
        <p className="text-muted-foreground">{pending.reason}</p>
        {pending.preview ? (
          <pre className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 text-xs">
            {pending.preview}
          </pre>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void resolveApproval(false)}
          >
            Deny
          </Button>
          <Button size="sm" onClick={() => void resolveApproval(true)}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
