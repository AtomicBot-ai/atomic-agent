/** Resolve production imports using TypeScript; enforce ownership and reject runtime cycles. */
import ts from 'typescript';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXCEPTIONS = 'docs/architecture/import-exceptions.json';
const slash = (p) => p.split(sep).join('/');
const edgeKey = ({ source, target }) => JSON.stringify([source, target]);
const domains = new Set(['config', 'llm', 'local-llm', 'agent', 'prompt', 'session', 'memory', 'tools', 'mcp', 'skills', 'tasks', 'approval', 'tracing', 'compressor']);
const compositionRoot = { source: 'src/cli/index.ts', target: 'src/tui/index.ts' };
const localModelTypeOwners = new Set([
  'src/local-llm/catalog/models-catalog.ts',
  'src/local-llm/backend/windows-backend-variant.ts',
  'src/local-llm/server/swa-full.ts',
]);
const localModelDefaultOwners = new Set([
  'src/config/local-models/local-models-types.ts',
  'src/local-llm/downloads/download-settings.ts',
  'src/local-llm/catalog/huggingface-endpoint.ts',
]);
const localModelParserOwners = new Set([
  'src/config/local-models/local-models-types.ts',
  'src/config/config-primitives.ts', 'src/config/config-values.ts',
  'src/config/config-validation-error.ts', 'src/config/custom-models-schema.ts',
  ...localModelTypeOwners,
  'src/local-llm/downloads/download-settings.ts',
  'src/local-llm/catalog/huggingface-endpoint.ts',
]);
const sharedViews = new Set([
  'pick-list.tsx', 'pick-list-geometry.ts', 'chip.tsx',
  'logo.tsx', 'logo-art.ts', 'logo-types.ts',
  'format-tokens.ts', 'fit-to-width.ts', 'render-progress-bar.ts', 'session-title.ts',
  'multi-line-editor.tsx', 'multi-line-editor-body.tsx',
  'multi-line-editor-clipboard.ts', 'multi-line-editor-cursor.ts',
  'multi-line-editor-edits.ts', 'multi-line-editor-input.ts',
  'multi-line-editor-keys.ts', 'multi-line-editor-pointer.ts',
].map((name) => `src/tui/components/${name}`));
sharedViews.add('src/tui/row-window.ts');

const resourceConfigOwners = {
  'src/config/agent/agent-types.ts': ['src/approval/approval-level.ts', 'src/config/agent-execution-config.ts'],
  'src/config/agent/agent-defaults.ts': ['src/config/agent/agent-types.ts', 'src/config/agent-execution-config.ts'],
  'src/config/agent/agent-parser.ts': ['src/config/agent/agent-types.ts', 'src/approval/approval-level.ts', 'src/config/agent-execution-config.ts', 'src/config/config-primitives.ts', 'src/config/config-validation-error.ts'],
  ...Object.fromEntries(['http-config', 'tool-config', 'skills-config'].map(owner => [`src/config/${owner}.ts`, ['src/config/config-primitives.ts', 'src/config/config-values.ts', 'src/config/config-validation-error.ts']])),
  ...Object.fromEntries(['session-retention-config', 'tracing-config'].map(owner => [`src/config/${owner}.ts`, ['src/config/config-primitives.ts', 'src/config/config-validation-error.ts']])),
};

const agentTypeContracts = new Set([
  'src/agent/agent-contract.ts', 'src/agent/step/step-contract.ts',
  'src/agent/dispatch/batch-contract.ts', 'src/agent/progress/loop-contract.ts',
]);
const agentFacades = new Set([
  'src/agent/index.ts', 'src/agent/agent-loop.ts', 'src/agent/step-executor.ts',
  'src/agent/batch-executor.ts',
]);
const agentLeaf = (source) => /^src\/agent\/(?:turn|step|dispatch|progress|policies)\//.test(source);

/** An ownership rule also applies to type dependencies: UI types are still UI contracts. */
export function violation(edge) {
  const { source, target } = edge;
  if (agentTypeContracts.has(source) && ['src/agent/agent-loop.ts', 'src/agent/step-executor.ts', 'src/agent/batch-executor.ts', 'src/agent/index.ts'].includes(target)) return 'agent contract depends on orchestration';
  if (/^src\/agent\/progress\/loop-(?:constants|fingerprints|notices)\.ts$/.test(source) && target === 'src/agent/loop-detector.ts' && edge.runtime) return 'pure progress helper loads tracker state';
  if (agentLeaf(source) && agentFacades.has(target) && edge.runtime) return 'agent leaf loads compatibility facade';
  if (source === 'src/runtime/runtime-contract.ts' && (target === 'src/runtime/bootstrap.ts' || target.startsWith('src/runtime/composition/'))) return 'public runtime contract depends on implementation';
  if (source.startsWith('src/runtime/composition/') && target === 'src/runtime/bootstrap.ts') return 'runtime component depends on composition root';
  if (source.startsWith('src/runtime/composition/') && target === 'src/runtime/runtime-contract.ts' && edge.runtime) return 'runtime component loads public type contract';
  if (target.startsWith('src/runtime/composition/') && source !== 'src/runtime/bootstrap.ts' && !source.startsWith('src/runtime/composition/')) return 'consumer bypasses public runtime contract';
  const area = source.split('/')[1];
  const frontendConfigOwners = {
    'src/config/tui-config.ts': ['src/config/config-primitives.ts', 'src/config/config-validation-error.ts', 'src/config/session-rail-config.ts'],
    'src/config/channel-config.ts': ['src/config/config-primitives.ts', 'src/config/config-validation-error.ts', 'src/config/config-values.ts'],
    'src/config/integration-config.ts': ['src/config/config-primitives.ts', 'src/config/config-validation-error.ts', 'src/config/config-values.ts'],
  };
  if (frontendConfigOwners[source] && target.startsWith('src/') && !frontendConfigOwners[source].includes(target)) return 'frontend config depends outside concrete value owners';
  const resourceTypes = source === 'src/config/agent/agent-types.ts' || target === 'src/config/agent/agent-types.ts' || target === 'src/approval/approval-level.ts';
  if (resourceConfigOwners[source] && target.startsWith('src/') && (!resourceConfigOwners[source].includes(target) || (resourceTypes && edge.runtime))) return 'resource config depends outside concrete configuration owners';
  if (source === 'src/config/config-primitives.ts' && ['src/config/config-schema.ts', 'src/config/index.ts'].includes(target)) return 'config primitive depends on composition';
  if (source === 'src/config/session-rail-config.ts' && ['src/config/config-schema.ts', 'src/config/index.ts'].includes(target)) return 'session rail config depends on composition';
  if (source === 'src/config/webhook-config.ts' && ['src/config/config-schema.ts', 'src/config/index.ts'].includes(target)) return 'webhook config depends on composition';
  if (source === 'src/config/agent-execution-config.ts' && ['src/config/config-schema.ts', 'src/config/index.ts'].includes(target)) return 'execution config depends on composition';
  if (source === 'src/config/web-config.ts' && target.startsWith('src/') && !['src/config/config-primitives.ts', 'src/config/config-validation-error.ts'].includes(target)) return 'web config depends outside scalar/error owners';
  if (source === 'src/config/memory/memory-types.ts' && target.startsWith('src/')) return 'memory config types depend on a source owner';
  if (source === 'src/config/memory/memory-defaults.ts' && target.startsWith('src/') && target !== 'src/config/memory/memory-types.ts') return 'memory defaults depend outside their type owner';
  if (source === 'src/config/memory/memory-parser.ts' && target.startsWith('src/') && !['src/config/memory/memory-types.ts', 'src/config/config-primitives.ts', 'src/config/config-values.ts', 'src/config/config-validation-error.ts', 'src/config/subcall-timeout-migration.ts'].includes(target)) return 'memory parser depends outside configuration owners';
  if (source === 'src/config/local-models/local-models-types.ts' && target.startsWith('src/') && (edge.runtime || !localModelTypeOwners.has(target))) return 'local models config types depend outside type owners';
  if (source === 'src/config/local-models/local-models-defaults.ts' && target.startsWith('src/') && (!localModelDefaultOwners.has(target) || (edge.runtime && target === 'src/config/local-models/local-models-types.ts'))) return 'local models defaults depend outside type/constant owners';
  if (source === 'src/config/local-models/local-models-parser.ts' && target.startsWith('src/') && (!localModelParserOwners.has(target) || (edge.runtime && target === 'src/config/local-models/local-models-types.ts'))) return 'local models parser depends outside concrete configuration helpers';
  if (['src/config/config-values.ts', 'src/config/mcp-server-config.ts'].includes(source) && ['src/config/config-schema.ts', 'src/config/index.ts'].includes(target)) return 'config value/MCP owner depends on composition';
  if (source === 'src/config/config-values.ts' && target === 'src/config/mcp-server-config.ts') return 'config values depends on MCP configuration';
  if (source === 'src/tools/os/fs/fs-hash-contract.ts' && target.startsWith('src/')) return 'hash contract depends on another source owner';
  if (['src/tools/os/fs/fs-locate-project-test-helpers.ts', 'src/local-llm/catalog/gguf-metadata.fixtures.ts'].includes(target)) return 'production depends on a test helper';
  if (domains.has(area) && (target.startsWith('src/tui/') || target.startsWith('src/channels/'))) return 'domain depends on an interface';
  if (area === 'channels' && target.startsWith('src/tui/')) return 'channel depends on TUI';
  if (area === 'http' && target.startsWith('src/tui/')) return 'HTTP interface depends on TUI';
  if (area === 'cli' && target.startsWith('src/tui/') && edgeKey(edge) !== edgeKey(compositionRoot)) return 'CLI bypasses its TUI composition root';
  if (sharedViews.has(source) || source.startsWith('src/tui/input/') || source.startsWith('src/tui/theme/')) {
    // Explicit shared owners; components/ also contains intentional shell composition.
    const allowed = sharedViews.has(target) || ['input', 'mouse', 'context-menu', 'clipboard', 'theme'].some((p) => target.startsWith(`src/tui/${p}/`));
    if (target.startsWith('src/tui/') && !allowed) return 'shared UI primitive depends on a feature';
    if (target.startsWith('src/') && !target.startsWith('src/tui/')) return 'shared UI primitive depends on a domain';
  }
  if (source === 'src/tui/composer-switch/composer-switch-row-contracts.ts' && /\/composer-switch-(?:worker-)?rows\.ts$/.test(target)) return 'shared composer contract depends on row builders';
  return null;
}

function runtimeDeclaration(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true; // Side effect import.
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    return !bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0 || bindings.elements.some((s) => !s.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  return !node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0 || node.exportClause.elements.some((s) => !s.isTypeOnly);
}

/** Static declarations, literal dynamic imports, and import() type references. */
function references(source) {
  const refs = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ name: node.moduleSpecifier.text, runtime: runtimeDeclaration(node) });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      refs.push({ name: node.arguments[0].text, runtime: true });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      refs.push({ name: node.argument.literal.text, runtime: false });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      refs.push({ name: node.moduleReference.expression.text, runtime: !node.isTypeOnly });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return refs;
}

function cycles(graph) {
  let next = 0;
  const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), result = [];
  function visit(v) {
    indices.set(v, next); low.set(v, next++); stack.push(v); onStack.add(v);
    for (const w of graph.get(v)) {
      if (!indices.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), indices.get(w)));
    }
    if (low.get(v) !== indices.get(v)) return;
    const group = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); group.push(w); } while (w !== v);
    if (group.length > 1 || graph.get(v).has(v)) result.push(group.sort());
  }
  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

export function check(root = ROOT) {
  root = resolve(root);
  const configPath = join(root, 'tsconfig.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) throw new Error(parsed.errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  // Tests never contribute edges to the production graph even if a future config includes them.
  const files = parsed.fileNames.filter((p) => !/\.(?:test|spec)\.tsx?$/.test(p) && !p.endsWith('.d.ts'));
  const names = new Set(files.map((p) => slash(relative(root, p))));
  const graph = new Map([...names].sort().map((p) => [p, new Set()]));
  const cache = ts.createModuleResolutionCache(root, (p) => p, parsed.options);
  const edges = new Map(), errors = [];
  for (const file of files) {
    const source = slash(relative(root, file));
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const ref of references(ast)) {
      if (agentTypeContracts.has(source) && ref.runtime) errors.push(`agent type contract has a runtime dependency: ${source} -> ${ref.name}`);
      if (source === 'src/runtime/runtime-contract.ts' && ref.runtime) errors.push(`public runtime contract has a runtime dependency: ${source} -> ${ref.name}`);
      // Contracts own literals and pure parsing; even a type/bare dependency
      // would make the cached catalog load another owner. Keep them import-free.
      if (/^src\/tools\/os\/fs\/fs-[a-z-]+-contract\.ts$/.test(source)) {
        const reason = source.endsWith('/fs-hash-contract.ts') ? 'hash contract depends on another source owner' : 'filesystem contract must be import-free';
        errors.push(`${reason}: ${source} -> ${ref.name}`);
      }
      if (!ref.name.startsWith('.') && !ref.name.startsWith('/')) continue; // Bare packages are external.
      const found = ts.resolveModuleName(ref.name, file, parsed.options, ts.sys, cache).resolvedModule;
      if (!found || !existsSync(found.resolvedFileName)) { errors.push(`unresolved local import: ${source} -> ${ref.name}`); continue; }
      const target = slash(relative(root, found.resolvedFileName));
      const edge = { source, target, runtime: ref.runtime };
      const prior = edges.get(edgeKey(edge));
      edges.set(edgeKey(edge), { ...edge, runtime: ref.runtime || (prior?.runtime ?? false) });
      if (ref.runtime && names.has(target)) graph.get(source).add(target);
      if (target.startsWith('src/') && !names.has(target) && !target.endsWith('.d.ts') && !target.endsWith('.json')) errors.push(`production import outside checked graph: ${source} -> ${target}`);
    }
  }
  const exceptionPath = join(root, EXCEPTIONS);
  const ledger = JSON.parse(readFileSync(exceptionPath, 'utf8'));
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.edges)) throw new Error('invalid import exception ledger');
  const exceptions = new Map();
  for (const entry of ledger.edges) {
    if (!entry.source?.startsWith('src/') || !entry.target?.startsWith('src/') || !entry.owner?.trim() || !entry.reason?.trim() || /[*?]/.test(entry.source + entry.target)) throw new Error('exceptions require exact source/target, owner and reason');
    const key = edgeKey(entry);
    if (exceptions.has(key)) throw new Error(`duplicate import exception: ${key}`);
    exceptions.set(key, entry);
  }
  const used = new Set();
  for (const edge of edges.values()) {
    const reason = violation(edge);
    if (!reason) continue;
    const key = edgeKey(edge);
    if (exceptions.has(key)) used.add(key);
    else errors.push(`${reason}: ${edge.source} -> ${edge.target}${edge.runtime ? '' : ' (type-only)'}`);
  }
  for (const [key, entry] of exceptions) if (!used.has(key)) errors.push(`stale import exception: ${entry.source} -> ${entry.target}`);
  const scc = cycles(graph);
  for (const group of scc) errors.push(`runtime import cycle: ${group.join(', ')}`);
  return { files: files.length, edges: [...edges.values()], cycles: scc, exceptions: exceptions.size, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = check();
    if (result.errors.length) { console.error(result.errors.join('\n')); process.exitCode = 1; }
    else console.log(`imports:check: ${result.files} modules, ${result.edges.length} local edges, 0 runtime cycles, ${result.exceptions} exceptions`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
