import { memo, useMemo } from "react";
import type { Components } from "react-markdown";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import type { PluginConfig } from "streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

import { cn, disableIndentedCodeBlockPlugin } from "@/lib/utils";
import { MermaidError } from "@/components/MermaidError";

interface MarkdownProps {
  content: string;
  className?: string;
  components?: Components;
  isUser?: boolean;
  messageId?: string;
  isAnimating?: boolean;
}

/**
 * The `@streamdown/*` plugin packages bundle their own (slightly diverged)
 * copy of streamdown's plugin types, so the object is asserted back to the
 * host `PluginConfig` the `Streamdown` component actually consumes.
 */
const STREAMDOWN_PLUGINS = { code, mermaid, cjk } as unknown as PluginConfig;

const latexCache = new Map<string, string>();

/**
 * Normalize `\[...\]` / `\(...\)` LaTeX fragments into `$$`/`$` so
 * remark-math picks them up. Code spans and HTML tags are preserved. Cached
 * to avoid reprocessing identical content across renders.
 */
function normalizeLatex(input: string): string {
  const cached = latexCache.get(input);
  if (cached !== undefined) return cached;

  const segments = input.split(/(```[\s\S]*?```|`[^`]*`|<[a-zA-Z/_!][^>]*>)/g);
  let result = "";

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (!segment) continue;
    if (i % 2 === 1) {
      result += segment;
      continue;
    }

    let s = segment;
    s = s.replace(/\$(\d+)(?![^\n]*\$([^\d]|$))/g, (_, num) => "\\$" + num);
    if (s.includes("\\[")) {
      s = s.replace(
        /(^|\n)\\\[\s*\n([\s\S]*?)\n\s*\\\](?=\n|$)/g,
        (_, pre, inner) => `${pre}$$\n${inner.trim()}\n$$`,
      );
    }
    if (s.includes("\\(")) {
      s = s.replace(
        /(^|[^$\\])\\\((.+?)\\\)(?=[^$\\]|$)/g,
        (_, pre, inner) => `${pre}$${inner.trim()}$`,
      );
    }
    result += s;
  }

  if (latexCache.size > 100) {
    const firstKey = latexCache.keys().next().value ?? "";
    latexCache.delete(firstKey);
  }
  latexCache.set(input, result);
  return result;
}

function RenderMarkdownComponent({
  content,
  className,
  isUser,
  components,
  messageId,
  isAnimating,
}: MarkdownProps) {
  const normalizedContent = useMemo(() => normalizeLatex(content), [content]);

  return (
    <div
      dir="auto"
      className={cn(
        "markdown wrap-break-word select-text",
        isUser && "is-user",
        className,
      )}
    >
      <Streamdown
        animate={isAnimating ?? true}
        animationDuration={500}
        linkSafety={{ enabled: false }}
        className={cn(
          "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        remarkPlugins={[remarkGfm, remarkMath, disableIndentedCodeBlockPlugin]}
        rehypePlugins={[rehypeKatex, defaultRehypePlugins.harden]}
        components={components}
        plugins={STREAMDOWN_PLUGINS}
        controls={{ mermaid: { fullscreen: false } }}
        mermaid={
          messageId
            ? {
                errorComponent: (props) => (
                  <MermaidError messageId={messageId} {...props} />
                ),
              }
            : {}
        }
      >
        {normalizedContent}
      </Streamdown>
    </div>
  );
}

export const RenderMarkdown = memo(
  RenderMarkdownComponent,
  (prev, next) => prev.content === next.content,
);
