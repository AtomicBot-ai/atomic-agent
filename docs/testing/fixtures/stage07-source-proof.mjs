/**
 * Reproduce stage 07 compatibility checks against an immutable pre-stage checkout.
 *
 * node docs/testing/fixtures/stage07-source-proof.mjs --baseline /path/to/pre07 \
 *   --output /tmp/stage07-source-evidence.json --proof-dir /tmp \
 *   --protected-hashes /path/to/captured-protected-hashes.json
 *
 * The baseline is an input, never generated from current files. This fixture
 * does not store a copy of repository source or run behavioral tests. Optional
 * --proof-dir runs the extraction-specific evidence scripts from that session;
 * missing evidence is a failure, not a skipped PASS.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const FACADES = [
  "agent-loop", "step-executor", "batch-executor", "loop-detector", "index",
  "read-coverage", "wandering-spread", "test-command-key", "workspace-fingerprint",
  "plan-mode", "fusion-orchestrator-mode", "claim-evidence", "link-evidence", "step-tool-set",
  "parse-failure-recovery", "empty-completion-recovery", "size-rejection-recovery", "truncation-recovery",
];
const PROOFS = [
  "atomic-stage07-a-proof.mjs", "atomic-stage07-a-wave2-proof.mjs",
  "atomic-stage07-turn-proof.mjs", "atomic-stage07-turn-recovery-proof.mjs",
  "atomic-stage07-c-proof.mjs", "atomic-stage07-progress-relocation-proof.mjs",
  "atomic-stage07-policy-recovery-relocation-proof.mjs",
];
const ROOT_OWNERS = new Set([
  "src/agent/agent-loop.ts", "src/agent/step-executor.ts",
  "src/agent/batch-executor.ts", "src/agent/loop-detector.ts",
  ...FACADES.slice(5).map((name) => `src/agent/${name}.ts`),
]);
const NEW_OWNER_DIRS = ["step", "turn", "dispatch", "progress", "policies"];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => fs.readFileSync(file, "utf8");
const argument = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const currentRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

function describeFunction(fn) {
  const methods = (object) => Object.fromEntries(Object.getOwnPropertyNames(object).sort().map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const value = descriptor.value;
    return [key, typeof value === "function"
      ? { kind: "function", name: value.name, arity: value.length }
      : { kind: descriptor.get || descriptor.set ? "accessor" : typeof value,
          ...(descriptor.get ? { get: { name: descriptor.get.name, arity: descriptor.get.length } } : {}),
          ...(descriptor.set ? { set: { name: descriptor.set.name, arity: descriptor.set.length } } : {}) }];
  }));
  return { kind: "function", name: fn.name, arity: fn.length,
    prototype: fn.prototype ? methods(fn.prototype) : null,
    staticKeys: Object.getOwnPropertyNames(fn).filter((key) => !["name", "length", "prototype"].includes(key)).sort() };
}
function describeValue(value) {
  if (typeof value === "function") return describeFunction(value);
  if (value instanceof Set) return { kind: "Set", entries: [...value].map(describeValue) };
  if (value instanceof Map) return { kind: "Map", entries: [...value].map(([k, v]) => [describeValue(k), describeValue(v)]) };
  if (Array.isArray(value)) return { kind: "array", entries: value.map(describeValue) };
  if (value !== null && typeof value === "object") return { kind: "object", entries: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, describeValue(v)])) };
  return { kind: typeof value, value: typeof value === "bigint" ? String(value) : value };
}

if (argument("--capture")) {
  const captureRoot = path.resolve(argument("--capture"));
  const result = {};
  for (const facade of FACADES) {
    const module = await import(pathToFileURL(path.join(captureRoot, "src/agent", `${facade}.ts`)));
    result[facade] = Object.fromEntries(Object.entries(module).map(([name, value]) => [name, describeValue(value)]));
  }
  fs.writeFileSync(argument("--output"), JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

const baseline = argument("--baseline");
assert.ok(baseline, "--baseline must point to an immutable pre-stage-07 checkout");
const baselineRoot = path.resolve(baseline);
assert.notEqual(baselineRoot, currentRoot, "current checkout cannot attest its own baseline");
const output = path.resolve(argument("--output") ?? path.join(os.tmpdir(), "stage07-source-evidence.json"));
const proofDir = argument("--proof-dir");
const protectedHashes = argument("--protected-hashes");
const checks = [];
const check = (label, operation) => { operation(); checks.push(label); };
const evidence = { baseline: baselineRoot, current: currentRoot, checks,
  limits: ["Source/public checks do not replace behavioral tests, typecheck or benchmarks.",
    "Function names/arity/prototypes/constants and TypeScript signatures are checked; cross-checkout object identity is not comparable.",
    "Extraction-specific source reconstruction needs the immutable snapshot and the original session manifests/scripts supplied by --proof-dir.",
    "Protected hashes have their own capture date/stage; a successful check covers that baseline, not an invented pre07 capture."] };

const work = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-stage07-source-proof-"));
try {
  const runtime = {};
  const tsx = createRequire(path.join(currentRoot, "package.json")).resolve("tsx");
  for (const [label, root] of [["before", baselineRoot], ["after", currentRoot]]) {
    const destination = path.join(work, `${label}.json`);
    const state = path.join(work, `${label}-state`);
    const run = spawnSync(process.execPath, ["--import", tsx, fileURLToPath(import.meta.url), "--capture", root, "--output", destination], {
      cwd: currentRoot, encoding: "utf8", env: { ...process.env, ATOMIC_AGENT_STATE_DIR: state },
    });
    assert.equal(run.status, 0, `${label} runtime capture failed: ${run.stderr}`);
    runtime[label] = JSON.parse(read(destination));
  }
  check("18 legacy/public facade runtime exports, names, arity, method prototypes and constants", () => assert.deepEqual(runtime.after, runtime.before));
  evidence.runtime = { modules: FACADES.length, exports: Object.values(runtime.before).reduce((n, v) => n + Object.keys(v).length, 0), sha256: sha(JSON.stringify(runtime.before)) };

  function signatures(root) {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), { noEmit: true }, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
    });
    const files = FACADES.map((name) => path.join(root, "src/agent", `${name}.ts`));
    const program = ts.createProgram(files, parsed.options);
    const checker = program.getTypeChecker();
    const stable = (text) => text.replaceAll(root, "<ROOT>").replaceAll(baselineRoot, "<ROOT>").replaceAll(currentRoot, "<ROOT>")
      .replace(/import\("<ROOT>\/src\/agent\/[^"\n]+"\)\./g, "");
    return Object.fromEntries(files.map((file, i) => {
      const source = program.getSourceFile(file);
      assert.ok(source, file);
      const module = checker.getSymbolAtLocation(source);
      return [FACADES[i], Object.fromEntries(checker.getExportsOfModule(module).map((exported) => {
        const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        const type = symbol.flags & ts.SymbolFlags.Value ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : checker.getDeclaredTypeOfSymbol(symbol);
        const describe = (signature) => stable(checker.signatureToString(signature, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteTypeArgumentsOfSignature));
        const calls = type.getCallSignatures().map(describe);
        const construct = type.getConstructSignatures().map(describe);
        const value = calls.length || construct.length
          ? { calls, construct, instanceMethods: construct.length ? Object.fromEntries(checker.getDeclaredTypeOfSymbol(symbol).getProperties().filter((s) => {
              const d = s.valueDeclaration ?? s.declarations?.[0];
              return !d.modifiers?.some((m) => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind));
            }).map((s) => [s.name, stable(checker.typeToString(checker.getTypeOfSymbolAtLocation(s, s.valueDeclaration ?? s.declarations[0]), undefined, ts.TypeFormatFlags.NoTruncation))])) : undefined }
          : { type: stable(checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias)) };
        return [exported.name, value];
      }))];
    }));
  }
  const beforeSignatures = signatures(baselineRoot), afterSignatures = signatures(currentRoot);
  check("18 legacy/public facade exported TypeScript signatures and class public members", () => assert.deepEqual(afterSignatures, beforeSignatures));
  evidence.signatures = { exports: Object.values(beforeSignatures).reduce((n, v) => n + Object.keys(v).length, 0), sha256: sha(JSON.stringify(beforeSignatures)) };

  function files(root, directory = "src") {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const relative = path.posix.join(directory, entry.name);
      return entry.isDirectory() ? files(root, relative) : [relative];
    });
  }
  const beforeFiles = files(baselineRoot), afterFiles = files(currentRoot), afterSet = new Set(afterFiles);
  const sourceHashes = JSON.parse(read(path.join(baselineRoot, "src-hashes.json")));
  check("immutable baseline src hashes", () => {
    assert.deepEqual(beforeFiles.slice().sort(), Object.keys(sourceHashes).sort());
    for (const file of beforeFiles) assert.equal(sha(fs.readFileSync(path.join(baselineRoot, file))), sourceHashes[file], file);
  });
  const changed = beforeFiles.filter((file) => afterSet.has(file) && sourceHashes[file] !== sha(fs.readFileSync(path.join(currentRoot, file))));
  const added = afterFiles.filter((file) => !Object.hasOwn(sourceHashes, file));
  const removed = beforeFiles.filter((file) => !afterSet.has(file));
  const routes = proofDir ? JSON.parse(read(path.join(proofDir, "atomic-stage07-agent-route-imports.json"))) : [];
  const consumers = proofDir ? JSON.parse(read(path.join(proofDir, "atomic-stage07-consumer-imports.json"))) : [];
  const recorded = new Map([...consumers, ...routes].map((record) => [record.path, record]));
  check("recorded transformations touch imports/exports only", () => {
    for (const record of [...consumers, ...routes]) {
      const ast = ts.createSourceFile(record.path, record.old, ts.ScriptTarget.Latest, true);
      for (const edit of record.edits) assert.ok(ast.statements.some((statement) =>
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        edit.start >= statement.getFullStart() && edit.end <= statement.end), `${record.path}: edit escapes import/export declaration`);
    }
  });
  check("outside-owner source bytes and recorded import edits", () => {
    for (const file of changed) {
      if (ROOT_OWNERS.has(file) || ["src/agent/README.md", "src/agent/docs/recovery.md", "src/agent/docs/batching.md"].includes(file)) continue;
      const record = recorded.get(file);
      assert.ok(record, `unrecorded existing source change: ${file}`);
      if (!file.startsWith("src/agent/")) assert.equal(record.old, read(path.join(baselineRoot, file)), `${file}: baseline bytes`);
      let expected = record.old;
      for (const edit of [...record.edits].sort((a, b) => b.start - a.start)) expected = expected.slice(0, edit.start) + (edit.text ?? edit.new) + expected.slice(edit.end);
      assert.equal(expected, record.result, `${file}: only recorded edits`);
      assert.equal(read(path.join(currentRoot, file)), record.result, `${file}: current bytes`);
    }
    for (const file of added) assert.ok(file === "src/agent/agent-contract.ts" || NEW_OWNER_DIRS.some((directory) => file.startsWith(`src/agent/${directory}/`)), `unowned new source file: ${file}`);
    for (const file of removed) {
      assert.ok(file.startsWith("src/agent/") && file.endsWith(".test.ts"), `unowned deletion: ${file}`);
      const name = path.basename(file);
      const destination = afterFiles.find((candidate) => NEW_OWNER_DIRS.some((d) => candidate === `src/agent/${d}/${name}`));
      assert.ok(destination, `${file}: relocated test missing`);
    }
  });
  evidence.source = { baselineFiles: beforeFiles.length, changed, added, removed,
    unchanged: beforeFiles.length - changed.length - removed.length,
    externalConsumerFiles: consumers.length, finalRouteFiles: routes.length };

  check("configuration, prompt, grammar, schemas and diagnostic debt unchanged", () => {
    for (const file of beforeFiles.filter((file) => ["src/config/", "src/prompt/", "src/llm/grammar/"].some((d) => file.startsWith(d)) || file.startsWith("src/tools/") && /(?:contract|schema)/.test(file))) {
      assert.equal(sha(fs.readFileSync(path.join(currentRoot, file))), sourceHashes[file], file);
    }
    for (const file of ["docs/testing/test-type-debt.json", "docs/testing/quarantine.json", "package.json", "package-lock.json"]) {
      assert.equal(read(path.join(currentRoot, file)), read(path.join(baselineRoot, file)), file);
    }
    for (const file of files(baselineRoot, "grammars")) assert.equal(read(path.join(currentRoot, file)), read(path.join(baselineRoot, file)), file);
  });

  if (protectedHashes) {
    const protectedBaseline = JSON.parse(read(protectedHashes));
    const expected = Object.keys(protectedBaseline).sort();
    const protectedFiles = ["EVIDENCE_ROUTER_MODEL.md", ...files(currentRoot, ".pr-review-56")].sort();
    check("protected files byte-identical to independently captured hashes", () => {
      assert.deepEqual(protectedFiles, expected, "protected file additions/deletions");
      for (const file of expected) assert.equal(sha(fs.readFileSync(path.join(currentRoot, file))), protectedBaseline[file], file);
    });
    evidence.protected = { capturedHashes: path.resolve(protectedHashes), captureScope: argument("--protected-since") ?? "the supplied independently captured hash snapshot", files: expected.length, manifestSha256: sha(read(protectedHashes)) };
  } else evidence.limits.push("Protected .pr-review-56/ and EVIDENCE_ROUTER_MODEL.md are not checked without --protected-hashes.");

  if (proofDir) {
    // Link recipe evidence to the actual integrated root, rather than proving
    // an abandoned extraction candidate only. Import statements are checked
    // above; these comparisons preserve executable declaration/comment tokens.
    const statementTokens = (text) => {
      const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text), values = [];
      for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (![ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia].includes(token)) values.push([token, scanner.getTokenText()]);
      }
      return values;
    };
    const namedNode = (text, name) => {
      const ast = ts.createSourceFile("recipe.ts", text, ts.ScriptTarget.Latest, true);
      const node = ast.statements.find((n) => n.name?.text === name);
      assert.ok(node, name);
      return node.getFullText(ast);
    };
    check("actual integrated step orchestration equals the reconstructed recipe", () => {
      let expected = read(path.join(proofDir, "atomic-stage07-a-wave2-facade.ts"));
      const prune = JSON.parse(read(path.join(proofDir, "atomic-stage07-a-wave2-unused-locals.json")));
      for (const [before, after] of prune.changes) { assert.ok(expected.includes(before)); expected = expected.replace(before, after); }
      for (const name of ["executeStep", "executeStepInner"]) assert.deepEqual(statementTokens(namedNode(read(path.join(currentRoot, "src/agent/step-executor.ts")), name)), statementTokens(namedNode(expected, name)), name);
    });
    check("actual integrated turn orchestration equals the proven sync recovery recipe", () => {
      assert.deepEqual(statementTokens(namedNode(read(path.join(currentRoot, "src/agent/agent-loop.ts")), "AgentLoop")), statementTokens(namedNode(read(path.join(proofDir, "atomic-stage07-turn-recovery-root.ts")), "AgentLoop")));
    });
    check("all 13 compatibility facades equal recorded replacements", () => {
      const progress = JSON.parse(read(path.join(proofDir, "atomic-stage07-progress-root-integration.json")));
      const policy = JSON.parse(read(path.join(proofDir, "atomic-stage07-policy-root-integration.json")));
      const facades = [...progress.filter((r) => r.action === "compatible facade"), ...policy];
      assert.equal(facades.length, 13);
      for (const record of facades) assert.equal(read(path.join(currentRoot, record.path)), record.new ?? record.result, record.path);
    });
    check("actual tracker state/class equals immutable pre07 state owner", () => {
      assert.deepEqual(statementTokens(namedNode(read(path.join(currentRoot, "src/agent/loop-detector.ts")), "ToolLoopTracker")), statementTokens(namedNode(read(path.join(baselineRoot, "src/agent/loop-detector.ts")), "ToolLoopTracker")));
    });
    check("actual scheduler functions equal immutable pre07 bodies", () => {
      for (const name of ["planBatch", "executeBatch", "toBatchInputs"]) assert.deepEqual(statementTokens(namedNode(read(path.join(currentRoot, "src/agent/dispatch/batch-scheduler.ts")), name)), statementTokens(namedNode(read(path.join(baselineRoot, "src/agent/batch-executor.ts")), name)), name);
    });
    evidence.relocation = [];
    for (const file of PROOFS) {
      const run = spawnSync(process.execPath, [path.join(proofDir, file)], { cwd: currentRoot, encoding: "utf8" });
      check(file, () => assert.equal(run.status, 0, run.stderr || run.stdout));
      evidence.relocation.push({ file, sha256: sha(read(path.join(proofDir, file))), result: run.stdout.trim() });
    }
  }
  evidence.status = "PASS";
} catch (error) {
  evidence.status = "FAIL";
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: evidence.status, checks: checks.length, output, error: evidence.error }));
