// Unit tests for main/mention-git.ts (ATO-2241), against the built output.
// Run: npm run build && npm run test:unit
// Every git call behind @diff, @git:N and the @folder/ listing starts with
// `--no-optional-locks -c core.fsmonitor=false`: the folder's own .git/config
// must not get to run a program through core.fsmonitor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../out/main/mention-git.js");
const L = require("../out/main/mention-local.js");

const SAFE = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];

/** An execFile stand-in that records the argv and answers `stdout`. */
function recorder(stdout = "") {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => callback(null, stdout));
  };
  return { calls, exec };
}

test("@diff, @git:N and ls-files each run git with the fsmonitor override in front", async () => {
  const { calls, exec } = recorder("x\n");
  const run = G.createRunGit(exec);
  await run("/repo", G.diffArgs());
  await run("/repo", G.logArgs(3));
  await run("/repo", G.lsFilesArgs());
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].args, [...SAFE, "diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "--", "."]);
  assert.deepEqual(calls[1].args, [...SAFE, "log", "-n3", "--date=iso", "--stat", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--relative", "--", "."]);
  assert.deepEqual(calls[2].args, [...SAFE, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  for (const call of calls) {
    assert.equal(call.file, "git");
    assert.equal(call.options.cwd, "/repo");
    assert.ok(call.options.timeout > 0 && call.options.maxBuffer > 0);
    // `-c` must come before the subcommand to be a global option.
    assert.ok(call.args.indexOf("core.fsmonitor=false") < call.args.findIndex((a) => ["diff", "log", "ls-files"].includes(a)));
  }
});

test("an inherited GIT_DIR does not point git at another repository", async () => {
  const before = process.env.GIT_DIR;
  process.env.GIT_DIR = "/somewhere/else/.git";
  try {
    const { calls, exec } = recorder();
    await G.createRunGit(exec)("/repo", G.diffArgs());
    assert.equal(calls[0].options.env.GIT_DIR, undefined);
  } finally {
    if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before;
  }
});

test("the folder listing goes through the guarded runGit, and a cut answer drops its half path", async () => {
  const seen = [];
  const listing = L.createListFolder(async (cwd, args) => {
    seen.push({ cwd, args });
    return { text: "a.ts\0deep/b.ts\0hal", cut: true };
  });
  assert.deepEqual(await listing("/repo/src"), ["a.ts", "deep/b.ts"]);
  assert.deepEqual(seen, [{ cwd: "/repo/src", args: G.lsFilesArgs() }]);
});

test("git output past the cap is kept as cut; any other failure rejects", async () => {
  const big = G.createRunGit((_f, _a, _o, cb) => {
    const err = Object.assign(new Error("maxBuffer"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    setImmediate(() => cb(err, "partial"));
  });
  assert.deepEqual(await big("/repo", G.diffArgs()), { text: "partial", cut: true });
  const broken = G.createRunGit((_f, _a, _o, cb) => setImmediate(() => cb(new Error("not a git repository"), "")));
  await assert.rejects(broken("/repo", G.diffArgs()));
});
