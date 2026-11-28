import { parse as parseYaml } from "yaml";

/**
 * Why a command file's front matter was ignored, or null when it was
 * read (or there is none). `parseCommandFile` falls back to defaults on a
 * broken block, which keeps the command usable but used to drop its
 * description and argument hint without a word (ATO-2773). Same block
 * detection as `parseCommandFile`.
 */
export function frontMatterProblem(content: string): string | null {
  const text = content.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return "front matter has no closing --- line";
  let parsed: unknown;
  try {
    parsed = parseYaml(text.slice(4, end));
  } catch (err) {
    // The block starts on the file's second line.
    const line = (err as { linePos?: ReadonlyArray<{ line?: number }> }).linePos?.[0]?.line;
    return typeof line === "number"
      ? `could not parse front matter at line ${line + 1}`
      : "could not parse front matter";
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return "front matter is not a list of key: value lines";
  }
  return null;
}
