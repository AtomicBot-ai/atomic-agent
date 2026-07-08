import { memo } from "react";

import type { ChatMessage, ToolStep } from "@/chat-types";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { RenderMarkdown } from "@/containers/render-markdown";

interface MessageItemProps {
  message: ChatMessage;
}

function MessageItemComponent({
  message,
}: MessageItemProps): React.ReactElement {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="inline-block max-w-[80%] whitespace-pre-wrap rounded-md bg-secondary p-2 text-sm text-foreground">
          {message.text}
        </div>
      </div>
    );
  }

  const streaming = message.streaming ?? false;
  // Reasoning is "still streaming" until the visible answer starts — the model
  // thinks first, then replies. Once `text` appears the panel auto-collapses.
  const reasoningStreaming = streaming && message.text.length === 0;

  return (
    <div className="flex w-full flex-col gap-3">
      {message.reasoning ? (
        <Reasoning
          className="w-full"
          isStreaming={reasoningStreaming}
          defaultOpen={reasoningStreaming}
        >
          <ReasoningTrigger />
          <ReasoningContent>{message.reasoning}</ReasoningContent>
        </Reasoning>
      ) : null}

      {message.steps?.map((step, i) => (
        <ToolCall key={`${message.id}-tool-${i}`} step={step} />
      ))}

      {message.text ? (
        <RenderMarkdown
          content={message.text}
          isAnimating={streaming}
          messageId={message.id}
        />
      ) : null}
    </div>
  );
}

function ToolCall({ step }: { step: ToolStep }): React.ReactElement {
  const hasInput = step.args !== undefined && step.args !== null;
  const hasOutput = Boolean(step.summary);
  return (
    <Tool>
      <ToolHeader name={step.tool} status={step.status} />
      <ToolContent>
        {hasInput ? <ToolInput input={step.args} /> : null}
        {hasOutput ? (
          <ToolOutput
            summary={step.summary ?? ""}
            error={step.status === "error"}
          />
        ) : null}
      </ToolContent>
    </Tool>
  );
}

export const MessageItem = memo(MessageItemComponent);
