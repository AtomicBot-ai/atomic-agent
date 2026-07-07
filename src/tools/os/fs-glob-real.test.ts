import { describe, it, expect } from "vitest";
import { osFsGlobTool } from "./fs-glob.js";

// Developer-machine real-world smoke: hardcoded to a macOS home path, so it
// only runs on darwin. On other platforms `resolveUserPath` rejects the Unix
// path anyway, so gate the whole suite to darwin.
describe.runIf(process.platform === "darwin")("real-world: find Sibiliainen CV", () => {
  it("scope=$HOME, narrower pattern", async () => {
    const result = await osFsGlobTool.run(
      {
        pattern: ["**/*Sibili*", "**/CV*.pdf", "**/*CV.pdf"],
        cwd: "/Users/aleksejkalina",
        nocase: true,
        sortByMtime: true,
        limit: 30,
      },
      { workingDir: "/Users/aleksejkalina", sessionId: "t", stepIndex: 0, signal: new AbortController().signal },
    );
    const files = result.details.files as string[];
    console.error("HOME (narrower):", JSON.stringify(files.slice(0, 30), null, 2));
    console.error("meta:", { scanned: result.details.scanned, total: result.details.total, truncated: result.details.truncated });
    expect(files.some((f) => f.toLowerCase().includes("sibiliainen"))).toBe(true);
  }, 60_000);
});
