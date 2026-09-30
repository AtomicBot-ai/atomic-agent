import { describe, expect, it, vi } from "vitest";

import {
  createUserPathStore,
  removeUserPathEntry,
} from "./windows-user-path.js";

const DIR = "C:\\Users\\op\\AppData\\Local\\atomic-agent";

describe("removeUserPathEntry", () => {
  it("removes the entry install.ps1 appended", () => {
    expect(removeUserPathEntry(`C:\\Tools;${DIR}`, DIR)).toEqual({
      value: "C:\\Tools",
      changed: true,
    });
  });

  it("matches ignoring case and trailing backslashes, like install.ps1", () => {
    const current = `C:\\Tools;${DIR.toUpperCase()}\;D:\\bin`;
    expect(removeUserPathEntry(current, `${DIR}\\`).value).toBe(
      "C:\\Tools;D:\\bin",
    );
  });

  it("removes every copy, from any position", () => {
    expect(removeUserPathEntry(`${DIR};C:\\Tools;${DIR}`, DIR).value).toBe(
      "C:\\Tools",
    );
  });

  it("leaves every other entry byte for byte, empty slots included", () => {
    const current = `C:\\Tools;;%USERPROFILE%\\bin;${DIR};C:\\Program Files\\x;`;
    expect(removeUserPathEntry(current, DIR).value).toBe(
      "C:\\Tools;;%USERPROFILE%\\bin;C:\\Program Files\\x;",
    );
  });

  it("does not remove a parent, a child or a prefix of the install dir", () => {
    const current = `C:\\Users\\op\\AppData\\Local;${DIR}\\bin;${DIR}-old`;
    expect(removeUserPathEntry(current, DIR)).toEqual({
      value: current,
      changed: false,
    });
  });

  it("leaves a PATH of only the install dir empty", () => {
    expect(removeUserPathEntry(DIR, DIR)).toEqual({ value: "", changed: true });
  });

  it("refuses an empty install dir rather than matching empty slots", () => {
    expect(removeUserPathEntry("C:\\Tools;;D:\\bin", "").changed).toBe(false);
    expect(removeUserPathEntry("C:\\Tools;;D:\\bin", "\\").changed).toBe(false);
  });
});

describe("createUserPathStore", () => {
  it("reads the user Path through [Environment] and decodes it", async () => {
    const value = `C:\\Tools;C:\\Пользователи\\op\\bin;${DIR}`;
    const run = vi.fn(async () =>
      Buffer.from(value, "utf8").toString("base64"),
    );
    const store = createUserPathStore(run);
    expect(await store.read()).toBe(value);
    expect(run.mock.calls[0]?.[0]).toContain(
      "[Environment]::GetEnvironmentVariable('Path', 'User')",
    );
  });

  it("reads an unset user Path as null", async () => {
    const store = createUserPathStore(async () => "-\r\n");
    expect(await store.read()).toBeNull();
  });

  it("writes through [Environment] with the value off the command line", async () => {
    const value = "C:\\Tools;C:\\Пользователи\\op\\bin";
    const run = vi.fn(async (_script: string, _env: NodeJS.ProcessEnv) => "");
    await createUserPathStore(run).write(value);
    const [script, env] = run.mock.calls[0] ?? [];
    expect(script).toContain("[Environment]::SetEnvironmentVariable('Path',");
    expect(script).toContain("'User')");
    expect(script).not.toContain("Tools");
    const encoded = env?.ATOMIC_AGENT_USER_PATH_B64 ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(value);
  });
});
