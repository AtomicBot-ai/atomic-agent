/**
 * F35 — verification never writes into the deliverable.
 *
 * Run 13 left `verify.js`, `verification_final.txt` and
 * `verification_report.txt` in the game folder: workers wrote harnesses
 * next to the thing they were checking. `verify.run` takes every write
 * in a throwaway copy, and `verify.syntax` picks checkers that write
 * nothing (`compile()` over `py_compile`, `tsc --noEmit`, one
 * `node --check` per file). These tests snapshot the workspace before
 * and after and require it byte-identical.
 *
 * Out of scope here: `os.fs.trash` goes through Finder, which drops a
 * `.DS_Store` in the directory it trashed from. That is the trash
 * tool's to fix, not verification's.
 */
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AtomicAgentConfig } from "../../config/index.js";
import { runVerify } from "./run-verify.js";
import { verifySyntax } from "./verify-syntax.js";
import { createVerifyWorkspace, type VerifyWorkspace } from "./verify-workspace-copy.js";

const NODE = process.execPath;
const REAL_TSC = realpathSync(resolve(process.cwd(), "node_modules/.bin/tsc"));
const CONFIG: Pick<AtomicAgentConfig, "browser"> = {
  browser: { enabled: false, channel: "chrome", headless: true, cdpUrl: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1_000 },
};

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "atag-verify-f35-"));
  await writeFile(join(work, "index.html"), "<html><body><script>var a = 1;</script></body></html>\n");
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src", "app.js"), "var app = {};\n");
  await writeFile(join(work, "src", "tool.py"), "def f():\n    return 1\n");
  await writeFile(join(work, "src", "run.sh"), "echo hi\n");
  await writeFile(join(work, "src", "style.css"), ".a { color: red; }\n");
  await writeFile(join(work, "src", "lib.ts"), "export const n: number = 1;\n");
  await writeFile(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, incremental: true, types: [] }, include: ["src/**/*.ts"] }));
  await mkdir(join(work, "node_modules", ".bin"), { recursive: true });
  await symlink(REAL_TSC, join(work, "node_modules", ".bin", "tsc"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

/** Every path under `dir` with a digest of what it is: content, link target, or "dir". */
async function snapshotTree(dir: string, root = dir): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const rel = relative(root, path);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      out.set(rel, `link:${await readlink(path)}`);
    } else if (info.isDirectory()) {
      out.set(rel, "dir");
      for (const [k, v] of await snapshotTree(path, root)) out.set(k, v);
    } else {
      out.set(rel, createHash("sha256").update(await readFile(path)).digest("hex"));
    }
  }
  return out;
}

/**
 * The copies this test's runs made, so cleanup is asserted on exactly
 * those directories — the shared temp dir is also where a concurrent
 * test process keeps its copies.
 */
function recordingWorkspaces(): {
  dirs: string[];
  workspace: (workingDir: string) => Promise<VerifyWorkspace>;
} {
  const dirs: string[] = [];
  return {
    dirs,
    workspace: async (workingDir) => {
      const ws = await createVerifyWorkspace(workingDir);
      dirs.push(ws.dir);
      return ws;
    },
  };
}

function expectCopiesGone(dirs: readonly string[]): void {
  expect(dirs.length).toBeGreaterThan(0);
  for (const dir of dirs) {
    expect(dir).not.toBe(work);
    expect(existsSync(dir), `${dir} should have been removed`).toBe(false);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

describe("F35 — nothing verification does reaches the workspace", () => {
  it("a command that writes, appends, creates and deletes leaves the workspace byte-identical", async () => {
    const before = await snapshotTree(work);
    const copies = recordingWorkspaces();
    const out = await runVerify(
      {
        kind: "command",
        cmd: NODE,
        args: [
          "-e",
          "const fs=require('fs');" +
            "fs.writeFileSync('verify.js','harness');" +
            "fs.writeFileSync('verification_report.txt','all passed');" +
            "fs.mkdirSync('out'); fs.writeFileSync('out/log.txt','x');" +
            "fs.appendFileSync('index.html','<!-- tampered -->');" +
            "fs.unlinkSync('src/app.js');" +
            "process.stdout.write(fs.readdirSync('.').sort().join(','))",
        ],
        checks: ["exit 0", 'stdout contains "verify.js"'],
      },
      { workingDir: work, config: CONFIG, workspace: copies.workspace },
    );
    // The writes happened — in the copy.
    expect(out.ok).toBe(true);
    expect(out.isolated).toBe(true);
    expect(out.stdoutTail).toContain("verification_report.txt");
    expect(await snapshotTree(work)).toEqual(before);
    expectCopiesGone(copies.dirs);
  });

  it("a service that logs to its directory leaves the workspace byte-identical", async () => {
    const port = await freePort();
    const before = await snapshotTree(work);
    const server =
      "const http=require('http'),fs=require('fs');" +
      "http.createServer((q,s)=>{ fs.appendFileSync('access.log', q.url+'\\n'); s.end('ok') }).listen(" + port + ")";
    const copies = recordingWorkspaces();
    const out = await runVerify(
      { kind: "service", start: { cmd: NODE, args: ["-e", server] }, ready: { port }, requests: [{ path: "/a" }, { path: "/b" }], checks: ["status 200"] },
      { workingDir: work, config: CONFIG, workspace: copies.workspace },
    );
    expect(out.ok).toBe(true);
    expect(await snapshotTree(work)).toEqual(before);
    expectCopiesGone(copies.dirs);
  }, 30_000);

  it("the copy is removed even when the run is killed on timeout", async () => {
    const before = await snapshotTree(work);
    const copies = recordingWorkspaces();
    const out = await runVerify(
      { kind: "command", cmd: NODE, args: ["-e", "require('fs').writeFileSync('busy.txt','x'); setInterval(()=>{},1000)"], timeoutMs: 400 },
      { workingDir: work, config: CONFIG, workspace: copies.workspace },
    );
    expect(out.timedOut).toBe(true);
    expect(await snapshotTree(work)).toEqual(before);
    expectCopiesGone(copies.dirs);
  });

  it("verify.syntax leaves no bytecode, build info or temp files behind", async () => {
    const before = await snapshotTree(work);
    const report = await verifySyntax(
      ["index.html", "src/app.js", "src/tool.py", "src/run.sh", "src/style.css", "src/lib.ts", "tsconfig.json"],
      work,
    );
    expect(report.failed).toBe(0);
    // No `__pycache__`, no `tsconfig.tsbuildinfo` (incremental is on in
    // the fixture's tsconfig on purpose), no stray temp file.
    expect(await snapshotTree(work)).toEqual(before);
  }, 60_000);
});
