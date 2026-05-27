import { describe, it, expect } from "vitest";

import { DEFAULT_TOOL_DESCRIPTORS } from "./tool-descriptors.js";
import {
  attachDefaultArgsJsonSchema,
  getDefaultArgsJsonSchema,
} from "./default-tool-args-schemas.js";

/**
 * Pin tests for the default JSON Schemas wired into the cloud
 * `native_tools` transport. The shape of these schemas is part of the
 * cloud contract — changing a `required` array or relaxing a `type`
 * silently is exactly the kind of regression that re-introduces the
 * `os.shell.run` silent-arg-drop bug.
 */

describe("default tool argsJsonSchema map", () => {
  it("attaches a schema to every default descriptor that has one registered", () => {
    const missing: string[] = [];
    for (const d of DEFAULT_TOOL_DESCRIPTORS) {
      if (!d.argsJsonSchema) missing.push(d.name);
    }
    // Every default tool ships a schema. `reply` / `finish` are added by
    // the OpenAI adapter separately and are NOT in DEFAULT_TOOL_DESCRIPTORS,
    // so this assertion stays exhaustive.
    expect(missing).toEqual([]);
  });

  it("pins os.shell.run schema shape (cmd + args required, args is string[])", () => {
    const schema = getDefaultArgsJsonSchema("os.shell.run");
    expect(schema).toMatchObject({
      type: "object",
      required: ["cmd", "args"],
      additionalProperties: false,
    });
    const properties = (schema as { properties: Record<string, unknown> }).properties;
    expect(properties.cmd).toEqual({ type: "string" });
    expect(properties.args).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("pins memory.profile.set schema (key + value required, keywords is string[])", () => {
    const schema = getDefaultArgsJsonSchema("memory.profile.set");
    expect(schema).toMatchObject({
      type: "object",
      required: ["key", "value"],
      additionalProperties: false,
    });
    const properties = (schema as { properties: Record<string, unknown> }).properties;
    expect(properties.keywords).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("pins memory.notes.recall schema (everything optional, scope enum)", () => {
    const schema = getDefaultArgsJsonSchema("memory.notes.recall");
    expect(schema).toMatchObject({
      type: "object",
      required: [],
      additionalProperties: false,
    });
    const properties = (schema as { properties: Record<string, unknown> }).properties;
    expect(properties.scope).toEqual({
      type: "string",
      enum: ["project", "all"],
    });
  });

  it("attachDefaultArgsJsonSchema preserves an explicit override (MCP inputSchema path)", () => {
    const override = {
      type: "object" as const,
      properties: { custom: { type: "string" as const } },
      required: ["custom"],
      additionalProperties: false,
    };
    const result = attachDefaultArgsJsonSchema({
      name: "os.shell.run",
      summary: "shell",
      argsSchema: "{ cmd, args }",
      argsJsonSchema: override as Record<string, unknown>,
    });
    expect(result.argsJsonSchema).toBe(override);
  });

  it("attachDefaultArgsJsonSchema is a no-op for unknown tools", () => {
    const result = attachDefaultArgsJsonSchema({
      name: "this.tool.does.not.exist",
      summary: "x",
      argsSchema: "{}",
    });
    expect(result.argsJsonSchema).toBeUndefined();
  });
});
