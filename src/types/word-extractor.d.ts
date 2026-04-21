/**
 * `word-extractor` ships without TypeScript definitions. We only use its
 * default export (a class whose instances expose an `extract(path)` method
 * returning an object with `getBody()`), so declare just that surface.
 */
declare module "word-extractor" {
  export default class WordExtractor {
    extract(filePath: string): Promise<{
      getBody(): string;
      getHeaders?(): string;
      getFooters?(): string;
      getEndnotes?(): string;
      getFootnotes?(): string;
      getAnnotations?(): string;
    }>;
  }
}
