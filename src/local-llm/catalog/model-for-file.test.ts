import { describe, expect, it } from "vitest";

import { fileNameOf, findLocalModelForFile } from "./model-for-file.js";
import { getLocalModelDef, type LocalModelDef } from "./models-catalog.js";

describe("findLocalModelForFile (ATO-2482)", () => {
  const qwen = getLocalModelDef("qwen-3.5-4b");

  it("matches a served path to its catalog entry by file name, any separator or case", () => {
    expect(findLocalModelForFile(`/data/models/qwen-3.5-4b/${qwen.filename}`)?.id).toBe("qwen-3.5-4b");
    expect(findLocalModelForFile(`C:\\Models\\${qwen.filename.toUpperCase()}`)?.id).toBe("qwen-3.5-4b");
    expect(findLocalModelForFile("/models/unknown.gguf")).toBeUndefined();
    expect(fileNameOf("a\\b/c.gguf")).toBe("c.gguf");
  });

  it("prefers the last entry, the person's own, when two share a file name", () => {
    const own = { ...qwen, id: "custom-mine", family: "custom" } as LocalModelDef;
    expect(findLocalModelForFile(`/x/${qwen.filename}`, [qwen, own])?.id).toBe("custom-mine");
  });

  it("matches a model added from disk by its own path", () => {
    const disk = { ...qwen, id: "custom-disk", family: "custom", localPath: "/Users/me/w.gguf" } as LocalModelDef;
    expect(findLocalModelForFile("/Users/me/w.gguf", [qwen, disk])?.id).toBe("custom-disk");
  });
});
