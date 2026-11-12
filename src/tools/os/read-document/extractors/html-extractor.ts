import type { Extractor } from "./extractor-types.js";
import { htmlToMarkdown } from "./html-markdown.js";
import { decodeBytes, sniffHtmlCharset } from "./text-decode.js";

/**
 * HTML / XHTML extractor: decodes the file with its declared charset and
 * renders the body as light markdown (headings, lists, links, pipe tables)
 * instead of returning raw tags. A model that really wants the markup can
 * still pass `format: "plain"`, or read the file with os.fs.read.
 */
export const htmlExtractor: Extractor = async (input) => {
  const warnings: string[] = [];
  const decoded = decodeBytes(input.data, sniffHtmlCharset(input.data));
  if (decoded.warning) warnings.push(decoded.warning);
  const { text, title } = htmlToMarkdown(decoded.text);
  const startsWithTitle = title !== undefined && text.startsWith(`# ${title}`);
  const body = title && !startsWithTitle ? `# ${title}\n\n${text}` : text;
  if (body.length === 0) warnings.push("no visible text in the HTML body");
  return { format: "html", text: body, warnings };
};
