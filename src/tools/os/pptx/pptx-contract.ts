const NAME = "os.fs.write_pptx";

/**
 * `os.fs.write_pptx`: build an editable PowerPoint deck from a slide
 * list. The text sketch and the JSON Schema live side by side here, the
 * same way the `os.fs.*` contracts keep them (`fs-move-contract.ts`).
 *
 * `slides` carries `minItems`/`maxItems` on purpose: its items nest an
 * object, and a nested object must stay off the strict native-tools path
 * (the null-undo and the tagged-call reader walk the top level only).
 */
export const OS_FS_WRITE_PPTX_CONTRACT = {
  name: NAME,
  description:
    "Create an editable PowerPoint (.pptx) deck from a list of slides: a title, bullet points, an optional picture from disk, table or chart (column, bar, line, pie) and speaker notes per slide, with a simple colour theme. An existing file is replaced only with overwrite: true, never a deck the request hands in as an input. Dangerous — always requires approval.",
  readonly: false,
  resourceClass: "approval_gated",
  descriptor: {
    name: NAME,
    summary:
      "Create an editable PowerPoint .pptx deck (may require approval): per slide a title, bullets, at most one of a png/jpg/gif image path, a table (rows, first row = header) or a chart (column, bar, line, pie), and speaker notes. A slide with only title + subtitle is a title slide. Use it instead of scripts or pandoc for presentations.",
    argsSchema:
      '{ path: string /* ends in .pptx */, slides: { title: string, subtitle?: string, bullets?: string[] /* indent with two spaces per level */, image?: string, table?: (string | number)[][] /* first row is the header */, chart?: { type: "column" | "bar" | "line" | "pie", title?: string, categories: string[], series: { name: string, values: number[] }[] }, notes?: string }[], title?: string, author?: string, theme?: "light" | "dark" | "blue" | "warm", accentColor?: string /* hex like 2F6FEB */, font?: string, overwrite?: boolean }',
    tier: "rare",
  },
  argsJsonSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      slides: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            subtitle: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
            image: { type: "string" },
            table: {
              type: "array",
              maxItems: 30,
              items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }] } },
            },
            chart: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["column", "bar", "line", "pie"] },
                title: { type: "string" },
                categories: { type: "array", items: { type: "string" } },
                series: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      values: { type: "array", items: { anyOf: [{ type: "number" }, { type: "null" }] } },
                    },
                    required: ["name", "values"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["type", "categories", "series"],
              additionalProperties: false,
            },
            notes: { type: "string" },
          },
          required: ["title"],
          additionalProperties: false,
        },
      },
      title: { type: "string" },
      author: { type: "string" },
      theme: { type: "string", enum: ["light", "dark", "blue", "warm"] },
      accentColor: { type: "string" },
      font: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "slides"],
    additionalProperties: false,
  },
} as const;
