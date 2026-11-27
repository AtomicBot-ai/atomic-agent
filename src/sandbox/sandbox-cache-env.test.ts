import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureSandboxCacheRoot,
  SANDBOX_CACHE_DIR_NAME,
  SANDBOX_CACHE_VARS,
  withSandboxCacheEnv,
} from "./sandbox-cache-env.js";

const ROOT = "/var/tmp-op/atomic-agent-sandbox-cache-501";

// ATO-1651: inside the sandbox every package tool writes its cache to a
// private folder under temp, never the shared one in the home folder.
describe("withSandboxCacheEnv", () => {
  it("points every known cache variable into the sandbox cache", () => {
    const env = withSandboxCacheEnv({ PATH: "/usr/bin", HOME: "/home/op" }, ROOT);
    expect(env.npm_config_cache).toBe(`${ROOT}/npm`);
    expect(env.PIP_CACHE_DIR).toBe(`${ROOT}/pip`);
    expect(env.GOMODCACHE).toBe(`${ROOT}/go-mod`);
    expect(env.GOCACHE).toBe(`${ROOT}/go-build`);
    expect(env.CARGO_HOME).toBe(`${ROOT}/cargo`);
    expect(env.GRADLE_USER_HOME).toBe(`${ROOT}/gradle`);
    expect(env.YARN_CACHE_FOLDER).toBe(`${ROOT}/yarn`);
    expect(env.MAVEN_OPTS).toBe(`-Dmaven.repo.local=${ROOT}/m2`);
    for (const name of Object.keys(SANDBOX_CACHE_VARS)) {
      expect(env[name]?.startsWith(`${ROOT}/`)).toBe(true);
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
  });

  it("overrides the user's own cache settings, in any case spelling", () => {
    const env = withSandboxCacheEnv(
      {
        NPM_CONFIG_CACHE: "/home/op/.npm",
        npm_config_cache: "/home/op/.npm",
        GOMODCACHE: "/home/op/go/pkg/mod",
        CARGO_HOME: "/home/op/.cargo",
      },
      ROOT,
    );
    expect(env.NPM_CONFIG_CACHE).toBeUndefined();
    expect(env.npm_config_cache).toBe(`${ROOT}/npm`);
    expect(env.GOMODCACHE).toBe(`${ROOT}/go-mod`);
    expect(env.CARGO_HOME).toBe(`${ROOT}/cargo`);
    expect(Object.values(env).some((v) => v.startsWith("/home/op/."))).toBe(false);
  });

  it("keeps the user's MAVEN_OPTS and puts the sandbox repository last", () => {
    const env = withSandboxCacheEnv(
      { MAVEN_OPTS: "-Xmx2g -Dmaven.repo.local=/home/op/.m2/repository" },
      ROOT,
    );
    expect(env.MAVEN_OPTS).toBe(
      `-Xmx2g -Dmaven.repo.local=/home/op/.m2/repository -Dmaven.repo.local=${ROOT}/m2`,
    );
  });

  it("drops unset variables", () => {
    const env = withSandboxCacheEnv({ EMPTY: undefined }, ROOT);
    expect("EMPTY" in env).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("ensureSandboxCacheRoot", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "atomic-sbx-cache-")));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const expected = () => join(tmp, `${SANDBOX_CACHE_DIR_NAME}-${process.getuid!()}`);

  it("creates a private folder under temp and reuses it", () => {
    const dir = ensureSandboxCacheRoot(tmp);
    expect(dir).toBe(expected());
    expect(lstatSync(dir!).mode & 0o077).toBe(0);
    expect(ensureSandboxCacheRoot(tmp)).toBe(dir);
  });

  it("never uses a folder others can write into", () => {
    mkdirSync(expected());
    chmodSync(expected(), 0o777);
    const dir = ensureSandboxCacheRoot(tmp);
    expect(dir).not.toBe(expected());
    expect(dir!.startsWith(join(tmp, `${SANDBOX_CACHE_DIR_NAME}-`))).toBe(true);
  });

  it("never follows a link planted under the expected name", () => {
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, expected());
    const dir = ensureSandboxCacheRoot(tmp);
    expect(dir).not.toBe(expected());
    expect(dir).not.toBe(elsewhere);
  });
});
