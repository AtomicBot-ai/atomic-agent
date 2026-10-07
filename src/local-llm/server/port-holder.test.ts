import { describe, expect, it } from "vitest";

import {
  atagDataDirOf,
  findPortHolder,
  isStateDirInUse,
  parseLsofPids,
  parseNetstatListeningPid,
  parseSsPid,
  type RunCommand,
} from "./port-holder.js";

const hasVersionFile = (dirs: string[]) => (path: string) =>
  dirs.some((d) => path === `${d}/backend/backend-version.json` || path === `${d}\\backend\\backend-version.json`);

describe("output parsers", () => {
  it("lsof -t", () => {
    expect(parseLsofPids("46051\n")).toEqual([46051]);
    expect(parseLsofPids("12\r\n34\n\n")).toEqual([12, 34]);
    expect(parseLsofPids("")).toEqual([]);
  });

  it("netstat -ano picks the LISTENING row on that port only", () => {
    const out = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:19091        127.0.0.1:50123        ESTABLISHED     900",
      "  TCP    127.0.0.1:190910       0.0.0.0:0              LISTENING       901",
      "  TCP    127.0.0.1:19091        0.0.0.0:0              LISTENING       4242",
    ].join("\r\n");
    expect(parseNetstatListeningPid(out, 19091)).toBe(4242);
    expect(parseNetstatListeningPid(out, 19092)).toBeNull();
  });

  it("ss -ltnpH", () => {
    expect(
      parseSsPid('LISTEN 0 512 127.0.0.1:19091 0.0.0.0:* users:(("llama-server",pid=777,fd=3))'),
    ).toBe(777);
    expect(parseSsPid("")).toBeNull();
  });
});

describe("atagDataDirOf", () => {
  it("recognises <dataDir>/backend/llama-server with its version file", () => {
    const exists = hasVersionFile(["/tmp/aa-qa/models"]);
    expect(atagDataDirOf("/tmp/aa-qa/models/backend/llama-server", exists)).toBe("/tmp/aa-qa/models");
  });

  it("is not fooled by another app's llama-server or a missing version file", () => {
    const exists = hasVersionFile(["/tmp/aa-qa/models"]);
    // Atomic Chat's bundled build
    expect(
      atagDataDirOf("/Users/x/Library/Application Support/Atomic Chat/data/llamacpp/backends/b1/build/bin/llama-server", exists),
    ).toBeNull();
    // right shape, but no backend-version.json beside it
    expect(atagDataDirOf("/opt/other/backend/llama-server", exists)).toBeNull();
    // right folder, wrong binary
    expect(atagDataDirOf("/tmp/aa-qa/models/backend/ollama", exists)).toBeNull();
  });
});

describe("findPortHolder", () => {
  const exists = hasVersionFile(["/tmp/aa-qa/models"]);

  it("macOS: lsof for the pid, ps comm for the executable", async () => {
    const calls: string[] = [];
    const run: RunCommand = async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "lsof") return { code: 0, stdout: "46051\n" };
      if (file === "ps") return { code: 0, stdout: "/tmp/aa-qa/models/backend/llama-server\n" };
      return null;
    };
    expect(await findPortHolder(19091, { run, platform: "darwin", exists })).toEqual({
      pid: 46051,
      executable: "/tmp/aa-qa/models/backend/llama-server",
      atagDataDir: "/tmp/aa-qa/models",
    });
    expect(calls).toEqual([
      "lsof -nP -iTCP:19091 -sTCP:LISTEN -t",
      "ps -o comm= -p 46051",
    ]);
  });

  it("linux: falls back to ss without lsof, reads /proc/<pid>/exe", async () => {
    const run: RunCommand = async (file) =>
      file === "ss"
        ? { code: 0, stdout: 'LISTEN 0 5 127.0.0.1:19091 0.0.0.0:* users:(("llama-server",pid=88,fd=3))' }
        : null;
    const holder = await findPortHolder(19091, {
      run,
      platform: "linux",
      exists,
      readlink: (p) => {
        expect(p).toBe("/proc/88/exe");
        return "/usr/bin/llama-server";
      },
    });
    expect(holder).toEqual({ pid: 88, executable: "/usr/bin/llama-server", atagDataDir: null });
  });

  it("nothing listening, or no tool at all, is null", async () => {
    expect(await findPortHolder(1, { run: async () => ({ code: 1, stdout: "" }), platform: "darwin" })).toBeNull();
    expect(await findPortHolder(1, { run: async () => null, platform: "darwin" })).toBeNull();
  });
});

describe("isStateDirInUse", () => {
  const db = "/tmp/aa-qa/sessions.sqlite";
  const exists = (p: string) => p === db;

  it("false only when lsof positively reports nobody has sessions.sqlite open", async () => {
    const run: RunCommand = async (file, args) => {
      expect([file, ...args]).toEqual(["lsof", "-t", "--", db]);
      return { code: 1, stdout: "" };
    };
    expect(await isStateDirInUse("/tmp/aa-qa/models", { run, platform: "darwin", exists })).toBe(false);
  });

  it("true when a process holds it", async () => {
    const run: RunCommand = async () => ({ code: 0, stdout: "79429\n" });
    expect(await isStateDirInUse("/tmp/aa-qa/models", { run, platform: "darwin", exists })).toBe(true);
  });

  it("true whenever it cannot tell: no lsof, Windows, no sessions.sqlite beside the data dir", async () => {
    expect(await isStateDirInUse("/tmp/aa-qa/models", { run: async () => null, platform: "darwin", exists })).toBe(true);
    expect(await isStateDirInUse("/tmp/aa-qa/models", { run: async () => ({ code: 1, stdout: "" }), platform: "win32", exists })).toBe(true);
    expect(
      await isStateDirInUse("/relocated/models", { run: async () => ({ code: 1, stdout: "" }), platform: "darwin", exists }),
    ).toBe(true);
  });
});
