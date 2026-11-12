import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { writeCurlHeaderFile } from "./curl-header-file.js";

const posix = process.platform !== "win32";

describe("writeCurlHeaderFile (ATO-1177)", () => {
  it("returns no args and writes nothing for no headers", async () => {
    const file = await writeCurlHeaderFile({});
    expect(file.args).toEqual([]);
    await file.cleanup();
  });

  it("writes one line per header and points curl at it with -H @file", async () => {
    const file = await writeCurlHeaderFile({
      "x-api-key": "sk-secret",
      Accept: "application/json",
    });
    try {
      expect(file.args).toHaveLength(2);
      expect(file.args[0]).toBe("-H");
      expect(file.args[1]!.startsWith("@")).toBe(true);
      expect(file.args.join(" ")).not.toContain("sk-secret");
      const path = file.args[1]!.slice(1);
      expect(readFileSync(path, "utf8")).toBe(
        "x-api-key: sk-secret\nAccept: application/json\n",
      );
      if (posix) {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await file.cleanup();
    }
  });

  it("cleanup removes the file and its directory", async () => {
    const file = await writeCurlHeaderFile({ a: "b" });
    const path = file.args[1]!.slice(1);
    await file.cleanup();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("refuses a value that would smuggle a second header line", async () => {
    await expect(
      writeCurlHeaderFile({ a: "b\r\nAuthorization: x" }),
    ).rejects.toThrow(/line break/);
  });
});
