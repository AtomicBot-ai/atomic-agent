import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FUSION_WORKER_ID_PREFIX } from "../../session/fusion-worker-session.js";
import {
  checkWorkerRead,
  findSessionReadOutside,
  READ_REFUSAL_REASON,
  sessionReadRefusal,
  sessionReadRoots,
} from "./read-scope.js";

const WORKER = `${FUSION_WORKER_ID_PREFIX}1`;

describe("session read scope (the check)", () => {
  let work: string;
  // Everything "outside" is lexical and off the temp directory: the temp
  // directory is scratch and always in scope, so a fixture there would
  // never be questioned. The checks canonicalise a path that does not exist.
  const elsewhere = "/srv/homes/other-run/work";
  const named = "/srv/homes/me/Desktop";

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "read-scope-"));
    mkdirSync(join(work, "src"), { recursive: true });
    writeFileSync(join(work, "src", "main.ts"), "mine");
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const session = (readRoots?: readonly string[]) => ({
    sessionId: "s-plain",
    workingDir: work,
    ...(readRoots ? { readRoots } : {}),
  });
  const outside = (
    tool: string,
    args: Record<string, unknown>,
    ctx = session(),
  ) => findSessionReadOutside(tool, args, ctx, sessionReadRoots(ctx));

  it("names the first path a read reaches outside the working directory", () => {
    expect(outside("os.fs.read", { path: join(elsewhere, "solution.js") })).toBe(
      join(elsewhere, "solution.js"),
    );
  });

  it("allows reads inside the working directory, by relative or absolute path", () => {
    for (const [tool, args] of [
      ["os.fs.read", { path: "src/main.ts" }],
      ["os.fs.read", { path: join(work, "src", "main.ts") }],
      ["os.fs.list", { path: "." }],
      ["os.fs.grep", { pattern: "x" }],
      ["os.fs.glob", { pattern: "**/*.ts", cwd: "src" }],
    ] as const) {
      expect(outside(tool, { ...args }), tool).toBeNull();
    }
  });

  it("allows a path the user named — the file itself, or anything under a named directory", () => {
    const file = join(named, "report.pdf");
    expect(
      outside("os.fs.read_document", { path: file }, session([file])),
    ).toBeNull();
    expect(outside("os.fs.read", { path: file }, session([named]))).toBeNull();
    expect(outside("os.fs.list", { path: named }, session([named]))).toBeNull();
    // A named file widens to that file only.
    expect(
      outside("os.fs.read", { path: join(named, "other.pdf") }, session([file])),
    ).toBe(join(named, "other.pdf"));
  });

  it("allows anything under a root handed in beyond the context's — an approved directory", () => {
    const ctx = session();
    expect(
      findSessionReadOutside(
        "os.fs.read",
        { path: join(elsewhere, "solution.js") },
        ctx,
        [...sessionReadRoots(ctx), elsewhere],
      ),
    ).toBeNull();
  });

  it("checks every path a multi-path tool names and skips URLs", () => {
    expect(
      outside("os.fs.diff", {
        aPath: "src/main.ts",
        bPath: join(elsewhere, "solution.js"),
      }),
    ).toBe(join(elsewhere, "solution.js"));
    expect(
      outside("vision.describe", { path: "https://example.com/a.png" }),
    ).toBeNull();
  });

  it("treats the temp directory as scratch: always in scope, whatever the roots", () => {
    for (const path of [
      join(tmpdir(), "helper.py"),
      ...(process.platform === "win32" ? [] : ["/tmp/out.txt", "/var/tmp/x"]),
    ]) {
      expect(outside("os.fs.read", { path }), path).toBeNull();
    }
    // A worker gets no such allowance: its rule predates the scope.
    expect(
      checkWorkerRead(
        "os.fs.read",
        { path: join(tmpdir(), "helper.py") },
        { sessionId: WORKER, workingDir: work },
        [],
      ),
    ).not.toBeNull();
  });

  it("leaves worker sessions to the worker check", () => {
    const ctx = { sessionId: WORKER, workingDir: work };
    expect(
      findSessionReadOutside(
        "os.fs.read",
        { path: join(elsewhere, "solution.js") },
        ctx,
        sessionReadRoots(ctx),
      ),
    ).toBeNull();
  });

  it("the refusal names the path, the working directory and the way out", () => {
    const path = join(elsewhere, "solution.js");
    const refusal = sessionReadRefusal("os.fs.read", path, session(), [work]);
    expect(refusal.status).toBe("error");
    expect(refusal.summary).toBe(
      `os.fs.read refused: reads are confined to the working directory (${work}) and the paths the user named; ` +
        `ask the user to name ${path} or to set agent.readScope: unrestricted`,
    );
    expect(refusal.details.reason).toBe(READ_REFUSAL_REASON);
    expect(refusal.details.path).toBe(path);
    expect(refusal.details.allowedRoots).toEqual([work]);
  });
});
