/**
 * Per-tool JSON Schemas for the cloud `native_tools` transport.
 *
 * The runtime keeps the canonical, human-readable `argsSchema` text on
 * each `ToolDescriptor` (rendered into the stable prefix and read by
 * the LLM). This module ships a parallel map of structured JSON
 * Schemas consumed by `descriptorsToOpenAiTools` so cloud providers
 * (OpenAI / OpenRouter / Together / DeepSeek / Qwen-Max) can validate
 * `tool_calls.arguments` against a real schema instead of an open
 * `{ additionalProperties: true }` shape. The latter is what we
 * shipped originally and it was load-bearing for the `os.shell.run`
 * silent-drop bug: the model double-serialised `args` into a JSON
 * string, the provider happily forwarded it, the tool coerced the
 * non-array to `[]` without warning, and the model never learned its
 * call was wrong.
 *
 * Local llama-server with GBNF does **not** consume these schemas;
 * the grammar there already constrains the shape and the prompt-side
 * `argsSchema` string is what the model reads.
 *
 * Conventions:
 *   - `additionalProperties: false` everywhere. Models that pad with
 *     stray keys ("explanation", "thoughts", "reasoning") get a clean
 *     400 from the provider and learn to stop.
 *   - Enums match the runtime validators verbatim.
 *   - Optional fields are absent from `required`.
 *   - Schemas are deliberately permissive on string lengths /
 *     numerics — runtime validators do the strict checks; the schema
 *     guards the **shape**.
 */

import type { ToolDescriptor } from "./stable-prefix.js";

type Schema = Record<string, unknown>;

const stringSchema: Schema = { type: "string" };
const stringArraySchema: Schema = {
  type: "array",
  items: { type: "string" },
};
const numberSchema: Schema = { type: "number" };
const integerSchema: Schema = { type: "integer" };
const booleanSchema: Schema = { type: "boolean" };

function obj(
  properties: Record<string, Schema>,
  required: readonly string[] = [],
): Schema {
  return {
    type: "object",
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function objOpen(properties: Record<string, Schema>): Schema {
  return {
    type: "object",
    properties,
    additionalProperties: true,
  };
}

const DEFAULT_TOOL_ARGS_SCHEMAS: ReadonlyMap<string, Schema> = new Map<
  string,
  Schema
>([
  // ── browser ──────────────────────────────────────────────────────────────
  ["browser.navigate", obj({ url: stringSchema }, ["url"])],
  ["browser.click", obj({ ref: stringSchema }, ["ref"])],
  [
    "browser.type",
    obj(
      {
        ref: stringSchema,
        text: stringSchema,
        pressEnter: booleanSchema,
      },
      ["ref", "text"],
    ),
  ],
  ["browser.read_aria", obj({})],
  [
    "browser.search",
    obj({ query: stringSchema, engine: stringSchema }, ["query"]),
  ],
  [
    "browser.tabs",
    obj(
      {
        action: { type: "string", enum: ["list", "switch", "close", "new"] },
        index: integerSchema,
        url: stringSchema,
      },
      ["action"],
    ),
  ],
  [
    "browser.scroll",
    obj(
      {
        direction: { type: "string", enum: ["up", "down", "top", "bottom"] },
        amount: {
          anyOf: [
            { type: "string", enum: ["page", "half"] },
            { type: "number" },
          ],
        },
      },
      ["direction"],
    ),
  ],

  // ── os.shell ─────────────────────────────────────────────────────────────
  [
    "os.shell.run",
    obj(
      {
        cmd: stringSchema,
        args: stringArraySchema,
        cwd: stringSchema,
        timeoutMs: numberSchema,
      },
      ["cmd", "args"],
    ),
  ],

  // ── os.fs ────────────────────────────────────────────────────────────────
  [
    "os.fs.read",
    obj(
      {
        path: stringSchema,
        maxBytes: numberSchema,
        offset: numberSchema,
        limit: numberSchema,
        lineNumbers: booleanSchema,
      },
      ["path"],
    ),
  ],
  [
    "os.fs.write",
    obj(
      {
        path: stringSchema,
        content: stringSchema,
        mode: { type: "string", enum: ["replace", "append"] },
      },
      ["path", "content"],
    ),
  ],
  ["os.fs.trash", obj({ paths: stringArraySchema }, ["paths"])],
  [
    "os.fs.list",
    obj(
      {
        path: stringSchema,
        pattern: stringSchema,
        kind: { type: "string", enum: ["file", "dir"] },
        extensions: stringArraySchema,
        sort: { type: "string", enum: ["name", "size", "mtime"] },
        maxEntries: numberSchema,
      },
      ["path"],
    ),
  ],
  [
    "os.fs.glob",
    obj(
      {
        pattern: {
          anyOf: [stringSchema, stringArraySchema],
        },
        cwd: stringSchema,
        path: stringSchema,
        ignore: stringArraySchema,
        absolute: booleanSchema,
        limit: numberSchema,
        sortByMtime: booleanSchema,
        nocase: booleanSchema,
      },
      ["pattern"],
    ),
  ],
  [
    "os.fs.locate_project",
    obj(
      {
        name: stringSchema,
        limit: numberSchema,
      },
      ["name"],
    ),
  ],
  [
    "os.fs.grep",
    obj(
      {
        pattern: stringSchema,
        path: stringSchema,
        glob: {
          anyOf: [stringSchema, stringArraySchema],
        },
        type: stringSchema,
        caseInsensitive: booleanSchema,
        multiline: booleanSchema,
        outputMode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
        },
        contextBefore: numberSchema,
        contextAfter: numberSchema,
        contextAround: numberSchema,
        headLimit: numberSchema,
        offset: numberSchema,
        showLineNumbers: booleanSchema,
        timeoutMs: numberSchema,
      },
      ["pattern"],
    ),
  ],
  [
    "os.fs.edit",
    obj(
      {
        path: stringSchema,
        oldString: stringSchema,
        newString: stringSchema,
        replaceAll: booleanSchema,
      },
      ["path", "oldString", "newString"],
    ),
  ],
  [
    "os.fs.read_document",
    obj(
      {
        path: stringSchema,
        format: stringSchema,
        maxBytes: numberSchema,
        maxPages: numberSchema,
        pagesFrom: numberSchema,
        pagesTo: numberSchema,
        sheets: {
          type: "array",
          items: { anyOf: [stringSchema, numberSchema] },
        },
        pageSeparators: booleanSchema,
        includeTables: booleanSchema,
      },
      ["path"],
    ),
  ],
  [
    "os.fs.archive.list",
    obj(
      {
        path: stringSchema,
        format: { type: "string", enum: ["zip", "tar", "tar.gz", "gz"] },
      },
      ["path"],
    ),
  ],
  [
    "os.fs.archive.read_entry",
    obj(
      {
        path: stringSchema,
        entry: stringSchema,
        as: { type: "string", enum: ["utf8", "base64"] },
        maxBytes: numberSchema,
        format: { type: "string", enum: ["zip", "tar", "tar.gz", "gz"] },
      },
      ["path", "entry"],
    ),
  ],
  [
    "os.fs.archive.extract",
    obj(
      {
        path: stringSchema,
        destDir: stringSchema,
        overwrite: booleanSchema,
        followSymlinks: booleanSchema,
        include: stringArraySchema,
        limits: objOpen({
          maxTotalBytes: numberSchema,
          maxEntryBytes: numberSchema,
          maxEntries: numberSchema,
        }),
        format: { type: "string", enum: ["zip", "tar", "tar.gz", "gz"] },
      },
      ["path", "destDir"],
    ),
  ],
  [
    "os.fs.hash",
    obj(
      {
        path: stringSchema,
        algorithm: {
          type: "string",
          enum: ["md5", "sha1", "sha256", "sha512"],
        },
        encoding: { type: "string", enum: ["hex", "base64"] },
      },
      ["path"],
    ),
  ],
  [
    "os.fs.diff",
    obj({
      aPath: stringSchema,
      aText: stringSchema,
      aLabel: stringSchema,
      bPath: stringSchema,
      bText: stringSchema,
      bLabel: stringSchema,
      context: numberSchema,
      ignoreWhitespace: booleanSchema,
    }),
  ],
  [
    "os.fs.patch",
    obj({
      patch: stringSchema,
      patchPath: stringSchema,
      apply: booleanSchema,
      rootDir: stringSchema,
      fuzzFactor: numberSchema,
      stripComponents: numberSchema,
    }),
  ],
  [
    "os.fs.watch",
    obj(
      {
        path: stringSchema,
        timeoutMs: numberSchema,
        recursive: booleanSchema,
        events: {
          type: "array",
          items: {
            type: "string",
            enum: ["add", "change", "unlink", "addDir", "unlinkDir"],
          },
        },
        ignoreInitial: booleanSchema,
        maxEvents: numberSchema,
        stopAfterFirst: booleanSchema,
      },
      ["path"],
    ),
  ],

  // ── os.git ───────────────────────────────────────────────────────────────
  ["os.git.status", obj({ repo: stringSchema })],
  [
    "os.git.log",
    obj({
      repo: stringSchema,
      limit: numberSchema,
      revisionRange: stringSchema,
      path: stringSchema,
    }),
  ],
  [
    "os.git.diff",
    obj({
      repo: stringSchema,
      revisionRange: stringSchema,
      staged: booleanSchema,
      paths: stringArraySchema,
      context: numberSchema,
    }),
  ],
  [
    "os.git.show",
    obj({
      repo: stringSchema,
      revision: stringSchema,
      patch: booleanSchema,
    }),
  ],
  [
    "os.git.blame",
    obj(
      {
        repo: stringSchema,
        path: stringSchema,
        revision: stringSchema,
        startLine: numberSchema,
        endLine: numberSchema,
      },
      ["path"],
    ),
  ],
  [
    "os.git.branch",
    obj({
      repo: stringSchema,
      includeRemote: booleanSchema,
      contains: stringSchema,
      pattern: stringSchema,
    }),
  ],

  // ── os.proc ──────────────────────────────────────────────────────────────
  ["os.proc.list", obj({ filter: stringSchema, limit: numberSchema })],
  [
    "os.proc.kill",
    obj(
      {
        pid: numberSchema,
        signal: {
          type: "string",
          enum: ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"],
        },
      },
      ["pid"],
    ),
  ],

  // ── os.http ──────────────────────────────────────────────────────────────
  [
    "os.http.request",
    obj(
      {
        url: stringSchema,
        method: { type: "string", enum: ["GET", "POST"] },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        body: {
          anyOf: [{ type: "string" }, { type: "object" }],
        },
        timeoutMs: numberSchema,
        followRedirects: booleanSchema,
      },
      ["url"],
    ),
  ],

  // ── os.web ───────────────────────────────────────────────────────────────
  [
    "os.web.search",
    obj(
      {
        query: stringSchema,
        maxResults: numberSchema,
      },
      ["query"],
    ),
  ],
  [
    "os.web.fetch",
    obj(
      {
        url: stringSchema,
        extractMode: { type: "string", enum: ["markdown", "text"] },
        maxChars: numberSchema,
      },
      ["url"],
    ),
  ],

  // ── os.clipboard / os.window / os.notify ─────────────────────────────────
  ["os.clipboard.read", obj({})],
  ["os.clipboard.write", obj({ value: stringSchema }, ["value"])],
  ["os.window.list", obj({})],
  ["os.window.focus", obj({ title: stringSchema }, ["title"])],
  [
    "os.notify",
    obj(
      { title: stringSchema, message: stringSchema, sound: booleanSchema },
      ["title", "message"],
    ),
  ],

  // ── skill / tool ─────────────────────────────────────────────────────────
  ["skill.view", obj({ name: stringSchema }, ["name"])],
  ["tool.view", obj({ name: stringSchema }, ["name"])],
  [
    "skill.run_script",
    obj(
      {
        skill: stringSchema,
        script: stringSchema,
        args: stringArraySchema,
        timeoutMs: numberSchema,
      },
      ["skill", "script"],
    ),
  ],

  // ── memory.profile ───────────────────────────────────────────────────────
  [
    "memory.profile.set",
    obj(
      {
        key: stringSchema,
        value: stringSchema,
        pinned: booleanSchema,
        keywords: stringArraySchema,
      },
      ["key", "value"],
    ),
  ],
  ["memory.profile.remove", obj({ key: stringSchema }, ["key"])],
  ["memory.profile.list", obj({})],
  ["memory.profile.history", obj({ key: stringSchema }, ["key"])],

  // ── memory.notes ─────────────────────────────────────────────────────────
  [
    "memory.notes.store",
    obj(
      { content: stringSchema, tags: stringArraySchema },
      ["content"],
    ),
  ],
  [
    "memory.notes.recall",
    obj({
      query: stringSchema,
      id: numberSchema,
      k: numberSchema,
      scope: { type: "string", enum: ["project", "all"] },
      tags: stringArraySchema,
    }),
  ],
  ["memory.notes.forget", obj({ id: numberSchema }, ["id"])],

  // ── memory.lessons / memory.procedures ───────────────────────────────────
  [
    "memory.lessons.recall",
    obj({ id: numberSchema, query: stringSchema, k: numberSchema }),
  ],
  [
    "memory.procedures.recall",
    obj({ id: numberSchema, query: stringSchema, k: numberSchema }),
  ],

  // ── tasks ────────────────────────────────────────────────────────────────
  [
    "tasks.schedule",
    obj(
      {
        userMessage: stringSchema,
        at: numberSchema,
        inSeconds: numberSchema,
        newSession: booleanSchema,
        notify: { type: "string", enum: ["telegram"] },
      },
      ["userMessage"],
    ),
  ],
  [
    "tasks.cron",
    obj(
      {
        userMessage: stringSchema,
        expression: stringSchema,
        tz: stringSchema,
        notify: { type: "string", enum: ["telegram"] },
      },
      ["userMessage", "expression"],
    ),
  ],
  [
    "tasks.list",
    obj({
      status: stringSchema,
      sessionId: stringSchema,
      limit: numberSchema,
    }),
  ],
  ["tasks.cancel", obj({ id: stringSchema }, ["id"])],
  ["tasks.show", obj({ id: stringSchema }, ["id"])],

  // ── vision ───────────────────────────────────────────────────────────────
  [
    "vision.describe",
    obj(
      {
        prompt: stringSchema,
        path: stringSchema,
        paths: stringArraySchema,
      },
      ["prompt"],
    ),
  ],

  // ── mcp aggregates ───────────────────────────────────────────────────────
  [
    "mcp.resource.list",
    obj({ server: stringSchema, limit: numberSchema }, ["server"]),
  ],
  [
    "mcp.resource.read",
    obj({ server: stringSchema, uri: stringSchema }, ["server", "uri"]),
  ],
  [
    "mcp.prompt.list",
    obj({ server: stringSchema, limit: numberSchema }, ["server"]),
  ],
  [
    "mcp.prompt.get",
    obj(
      {
        server: stringSchema,
        name: stringSchema,
        arguments: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      ["server", "name"],
    ),
  ],

  // ── terminal verbs ───────────────────────────────────────────────────────
  // The OpenAI adapter overrides these with hand-tuned schemas (see
  // `descriptorToJsonSchema` in openai-tool-call-adapter.ts), but we
  // keep entries here so the "every default tool ships a schema" pin
  // test stays exhaustive.
  ["reply", obj({ text: stringSchema }, ["text"])],
  ["finish", obj({ summary: stringSchema, text: stringSchema })],
]);

/**
 * Returns the structured JSON Schema for a default tool's `args`, or
 * `undefined` when none is registered (the OpenAI adapter falls back
 * to an open object in that case).
 */
export function getDefaultArgsJsonSchema(
  name: string,
): Schema | undefined {
  return DEFAULT_TOOL_ARGS_SCHEMAS.get(name);
}

/**
 * Returns a copy of `descriptor` with `argsJsonSchema` populated when
 * a default schema is registered. Existing schemas (e.g. dynamic MCP
 * descriptors carrying server-supplied `inputSchema`) are preserved
 * verbatim — the per-tool default never wins over an explicit override.
 */
export function attachDefaultArgsJsonSchema(
  descriptor: ToolDescriptor,
): ToolDescriptor {
  if (descriptor.argsJsonSchema) return descriptor;
  const schema = DEFAULT_TOOL_ARGS_SCHEMAS.get(descriptor.name);
  if (!schema) return descriptor;
  return { ...descriptor, argsJsonSchema: schema };
}
