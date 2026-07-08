import {
  type HTMLAttributes,
  useEffect,
  useRef,
  useState,
} from "react";
import { type BundledLanguage, codeToHtml, type ShikiTransformer } from "shiki";

import { cn } from "@/lib/utils";

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

const lineNumberTransformer: ShikiTransformer = {
  name: "line-numbers",
  line(node, line) {
    node.children.unshift({
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "inline-block",
          "min-w-10",
          "mr-4",
          "text-right",
          "text-muted-foreground",
        ],
      },
      children: [{ type: "text", value: String(line) }],
    });
  },
};

async function highlightCode(
  code: string,
  language: BundledLanguage,
  showLineNumbers = false,
): Promise<[string, string]> {
  const transformers: ShikiTransformer[] = showLineNumbers
    ? [lineNumberTransformer]
    : [];

  return Promise.all([
    codeToHtml(code, { lang: language, theme: "one-light", transformers }),
    codeToHtml(code, { lang: language, theme: "one-dark-pro", transformers }),
  ]);
}

/**
 * Dual-theme (light/dark) Shiki-highlighted code block. Ported from Jan; used
 * inside tool call parameter/result panels. Highlighting is async — the block
 * renders empty until the first `codeToHtml` pair resolves.
 */
export function CodeBlock({
  code,
  language,
  showLineNumbers = false,
  className,
  ...props
}: CodeBlockProps): React.ReactElement {
  const [html, setHtml] = useState<string>("");
  const [darkHtml, setDarkHtml] = useState<string>("");
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void highlightCode(code, language, showLineNumbers).then(
      ([light, dark]) => {
        if (mounted.current) {
          setHtml(light);
          setDarkHtml(dark);
        }
      },
    );
    return () => {
      mounted.current = false;
    };
  }, [code, language, showLineNumbers]);

  return (
    <div
      className={cn(
        "group relative w-full overflow-hidden bg-background text-foreground",
        className,
      )}
      {...props}
    >
      <div
        className="overflow-auto dark:hidden [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-3 [&>pre]:text-foreground! [&>pre]:text-xs [&_code]:font-mono [&_code]:text-xs"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div
        className="hidden overflow-auto dark:block [&>pre]:m-0 [&>pre]:bg-background! [&>pre]:p-3 [&>pre]:text-foreground! [&>pre]:text-xs [&_code]:font-mono [&_code]:text-xs"
        dangerouslySetInnerHTML={{ __html: darkHtml }}
      />
    </div>
  );
}
