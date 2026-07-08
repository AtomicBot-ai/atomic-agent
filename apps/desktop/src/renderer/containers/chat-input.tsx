import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import TextareaAutosize from "react-textarea-autosize";
import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/i18n";
import { cancelTurn, sendMessage, startDraftChat } from "@/lib/chat-actions";
import { useSessionStore } from "@/stores/session-store";

interface ChatInputProps {
  /**
   * Target session. `null` means the New Chat draft — the first send lazily
   * creates a backend session and routes to its thread.
   */
  sessionId: string | null;
  autoFocus?: boolean;
}

/**
 * Composer styled after Jan's `ChatInput` shell: a rounded card with the
 * textarea and a bottom action bar. Wired to the sidecar via `chat.send`;
 * while a turn runs the send button flips to a stop action (`chat.cancel`).
 */
export function ChatInput({
  sessionId,
  autoFocus,
}: ChatInputProps): React.ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const phase = useSessionStore((s) =>
    sessionId ? (s.entries[sessionId]?.phase ?? "idle") : "idle",
  );
  const running = phase === "running";

  const submit = (): void => {
    const text = value.trim();
    if (!text || running) return;
    setValue("");
    if (sessionId) {
      void sendMessage(sessionId, text);
      return;
    }
    // Draft: create the backend session on first send, then route to it.
    void startDraftChat(text).then((id) => {
      if (!id) return;
      void router.navigate({
        to: "/thread/$sessionId",
        params: { sessionId: id },
      });
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="relative">
      <div
        className={cn(
          "relative overflow-hidden rounded-3xl p-0.5",
          running && "opacity-70",
        )}
      >
        <div
          className={cn(
            "relative z-20 rounded-3xl border border-input bg-white px-0 pb-12 dark:bg-input/30",
            focused && "ring-1 ring-ring/50",
          )}
        >
          <TextareaAutosize
            dir="auto"
            value={value}
            autoFocus={autoFocus}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={t("common:placeholder.chatInput", {
              defaultValue: "Ask me anything...",
            })}
            minRows={2}
            maxRows={10}
            className="w-full resize-none border-none bg-transparent px-4 pt-4 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="absolute bottom-0 z-20 w-full bg-transparent p-2">
        <div className="flex w-full items-center justify-end">
          {running ? (
            <Button
              size="icon-sm"
              variant="destructive"
              className="mb-1 mr-1 rounded-full"
              title="Stop"
              onClick={() => {
                if (sessionId) void cancelTurn(sessionId);
              }}
            >
              <Square className="size-4" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              className="mb-1 mr-1 rounded-full"
              title="Send"
              disabled={value.trim().length === 0}
              onClick={submit}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
