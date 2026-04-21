import type { Extractor } from "./extractor-types.js";

/**
 * DOCX text extractor backed by `mammoth`.
 *
 * Mammoth converts DOCX to HTML or markdown with configurable style maps.
 * For our purpose — producing token-frugal plain text for local LLMs — we
 * use `convertToMarkdown` and then strip the few markers that don't help
 * a model (HTML comments, reference-style links). We keep headings (`#`),
 * lists (`-`), and tables (`|`), which give the model cheap structural
 * hints.
 */
export const docxExtractor: Extractor = async (input) => {
  const mammoth = await loadMammoth();
  const warnings: string[] = [];

  const convertFn = input.includeTables === false
    ? mammoth.extractRawText
    : mammoth.convertToMarkdown;

  const result = await convertFn({ buffer: input.data });
  for (const msg of result.messages) {
    if (msg.type === "error" || msg.type === "warning") {
      warnings.push(`${msg.type}: ${msg.message}`);
    }
  }
  const text = normaliseMarkdown(result.value);
  return {
    format: "docx",
    text,
    warnings,
  };
};

function normaliseMarkdown(raw: string): string {
  return (
    raw
      // Collapse >2 blank lines to exactly 2 to keep paragraph breaks.
      .replace(/\n{3,}/g, "\n\n")
      // Trim trailing whitespace on each line.
      .split("\n")
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n")
      .trim()
  );
}

type MammothFn = (options: {
  buffer: Buffer;
}) => Promise<{
  value: string;
  messages: Array<{ type: string; message: string }>;
}>;

interface MammothModule {
  convertToMarkdown: MammothFn;
  extractRawText: MammothFn;
}

let mammothModule: MammothModule | undefined;
async function loadMammoth(): Promise<MammothModule> {
  if (!mammothModule) {
    // mammoth ships CommonJS; its ESM interop view exposes both the named
    // exports and a `.default` alias. We normalise to the shape we use via
    // `unknown` because its published types omit `convertToMarkdown`
    // despite the function existing in the JS source.
    const mod = (await import("mammoth")) as unknown as
      | MammothModule
      | { default: MammothModule };
    mammothModule = "default" in mod ? mod.default : mod;
  }
  return mammothModule;
}
