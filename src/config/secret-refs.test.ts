import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EMPTY_SECRET_SOURCES,
  parseSecretRef,
  readSecretSources,
  SECRET_SOURCES_FILE,
} from "./secret-refs.js";

describe("parseSecretRef", () => {
  it("reads the three schemes and leaves ordinary values alone", () => {
    expect(parseSecretRef("op://Private/OpenRouter/credential", "K")).toEqual({
      kind: "op",
      ref: "op://Private/OpenRouter/credential",
    });
    expect(parseSecretRef("op://Private/Item/Section/field", "K")).toMatchObject({ kind: "op" });
    expect(parseSecretRef("bw://github/password", "K")).toEqual({ kind: "bw", item: "github", field: "password" });
    expect(parseSecretRef("cmd://prod-db", "K")).toEqual({ kind: "command", key: "prod-db" });
    expect(parseSecretRef("cmd://", "MY_KEY")).toEqual({ kind: "command", key: "MY_KEY" });
    expect(parseSecretRef("sk-or-v1-abc123", "K")).toBeNull();
    expect(parseSecretRef("https://example.com", "K")).toBeNull();
  });

  it("returns an error for a malformed reference instead of a literal", () => {
    expect(typeof parseSecretRef("op://vault", "K")).toBe("string");
    expect(typeof parseSecretRef("op://v/i/f extra", "K")).toBe("string");
    expect(typeof parseSecretRef("bw://item", "K")).toBe("string");
    expect(typeof parseSecretRef("cmd://a b", "K")).toBe("string");
  });
});

describe("readSecretSources", () => {
  let dir: string;
  let warnings: string[];
  const warn = (m: string) => warnings.push(m);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-secret-sources-"));
    warnings = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (body: unknown) =>
    writeFileSync(join(dir, SECRET_SOURCES_FILE), typeof body === "string" ? body : JSON.stringify(body));

  it("is empty without a file", () => {
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    expect(warnings).toEqual([]);
  });

  it("reads command, passthrough, timeout and tool secrets", () => {
    write({
      command: ["/opt/helper", "get"],
      envPassthrough: ["VAULT_TOKEN"],
      timeoutMs: 5_000,
      toolSecrets: { DEPLOY_TOKEN: "op://Private/Deploy/credential", NPM_TOKEN: " bw://npm/password " },
    });
    expect(readSecretSources(dir, warn)).toEqual({
      command: ["/opt/helper", "get"],
      envPassthrough: ["VAULT_TOKEN"],
      timeoutMs: 5_000,
      timeoutSet: true,
      toolSecrets: { DEPLOY_TOKEN: "op://Private/Deploy/credential", NPM_TOKEN: "bw://npm/password" },
    });
  });

  it("refuses the whole file when a tool secret is a literal value, not a reference", () => {
    write({ toolSecrets: { DEPLOY_TOKEN: "ghp_plaintext0123456789abcdefghij" } });
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    expect(warnings[0]).toContain("toolSecrets.DEPLOY_TOKEN");
    expect(warnings[0]).not.toContain("ghp_plaintext");
  });

  it("refuses bad JSON and wrong shapes, failing closed", () => {
    write("{ not json");
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    write({ command: "op read" });
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    write({ timeoutMs: 0 });
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    write({ toolSecrets: { "bad-name": "op://a/b/c" } });
    expect(readSecretSources(dir, warn)).toBe(EMPTY_SECRET_SOURCES);
    expect(warnings).toHaveLength(4);
  });
});
