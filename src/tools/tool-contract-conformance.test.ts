import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ApprovalGate } from "../approval/approval-gate.js";
import { USER_CONFIG_DEFAULTS } from "../config/index.js";
import { ProfileStore } from "../memory/profile-store.js";
import { MemoryStore } from "../memory/memory-store.js";
import { LessonStore } from "../memory/lessons/lesson-store.js";
import { ProcedureStore } from "../memory/procedures/procedure-store.js";
import { TaskStore } from "../tasks/task-store.js";
import { TaskRunner } from "../tasks/task-runner.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { StructuredLogger } from "../tracing/structured-logger.js";
import { DEFAULT_TOOL_DESCRIPTORS, getToolDescriptorByName } from "../prompt/tool-descriptors.js";
import type { ToolDescriptor } from "../prompt/stable-prefix.js";
import { getDefaultArgsJsonSchema } from "../prompt/default-tool-args-schemas.js";
import { listKnownToolResourceClasses, resourceClassFor, setDynamicResourceClassResolver } from "../agent/tool-resource-class.js";
import { buildGrammarForTools, grammarToolNames } from "../llm/grammar/build-grammar.js";
import { descriptorsToOpenAiTools, nameEscape } from "../llm/provider/openai/openai-tool-call-adapter.js";
import { filterToolDescriptorsByConfig, GATED_TOOL_NAMES, type ToolGateConfig } from "../runtime/filter-disabled-tools.js";
import { McpManager } from "../mcp/mcp-manager.js";
import { McpClient } from "../mcp/mcp-client.js";
import { buildMcpResourceListTool, buildMcpResourceReadTool } from "../mcp/mcp-resource-tools.js";
import { buildMcpPromptListTool, buildMcpPromptGetTool } from "../mcp/mcp-prompt-tools.js";
import { buildMcpToolDescriptor } from "../mcp/mcp-descriptor-builder.js";
import { createMcpResourceClassResolver } from "../mcp/mcp-resource-class.js";
import type { McpToolMeta } from "../mcp/mcp-types.js";
import { ToolRegistry, type ToolDefinition } from "./tool-registry.js";
import { finishTool, replyTool } from "./index.js";
import { buildBrowserTools } from "./browser/index.js";
import type { BrowserBackend } from "./browser/browser-backend.js";
import { registerOsTools } from "./os/index.js";
import { ShellJobRegistry } from "./os/shell/shell-jobs.js";
import { registerVerifyTools } from "./verify/index.js";
import { registerGithubTools } from "./github/github-tools.js";
import { registerSkillTools } from "./skill/index.js";
import { buildToolViewTool } from "./tool-view/index.js";
import { registerMemoryTools } from "./memory/index.js";
import { registerTaskTools } from "./tasks/index.js";
import { registerVisionTools } from "./vision/index.js";
import { buildFusionDelegateTool } from "./fusion/fusion-delegate.js";
import { TOOL_ROLES, descriptorsForRole, partitionByRole, roleAdmits } from "./tool-roles.js";
import { confineReads } from "./read-scope/confine-reads.js";
import { READ_TOOL_TARGETS } from "./read-scope/read-scope-targets.js";

import { OS_FS_READ_CONTRACT } from "./os/fs/fs-read-contract.js";
import { OS_FS_LIST_CONTRACT } from "./os/fs/fs-list-contract.js";
import { OS_FS_GLOB_CONTRACT } from "./os/fs/fs-glob-contract.js";
import { OS_FS_GREP_CONTRACT } from "./os/fs/fs-grep-contract.js";
import { OS_FS_HASH_CONTRACT } from "./os/fs/fs-hash-contract.js";
import { OS_FS_DIFF_CONTRACT } from "./os/fs/fs-diff-contract.js";
import { OS_FS_WATCH_CONTRACT } from "./os/fs/fs-watch-contract.js";
import { OS_FS_WRITE_CONTRACT } from "./os/fs/fs-write-contract.js";
import { OS_FS_EDIT_CONTRACT } from "./os/fs/fs-edit-contract.js";
import { OS_FS_PATCH_CONTRACT } from "./os/fs/fs-patch-contract.js";
import { OS_FS_TRASH_CONTRACT } from "./os/fs/fs-trash-contract.js";
import { OS_FS_RESTORE_CONTRACT } from "./os/fs/fs-restore-contract.js";
import { OS_FS_LOCATE_PROJECT_CONTRACT } from "./os/fs/fs-locate-project-contract.js";

const CORE_CONTRACTS = [
  OS_FS_READ_CONTRACT,
  OS_FS_LIST_CONTRACT,
  OS_FS_GLOB_CONTRACT,
  OS_FS_GREP_CONTRACT,
  OS_FS_HASH_CONTRACT,
  OS_FS_DIFF_CONTRACT,
  OS_FS_WATCH_CONTRACT,
  OS_FS_WRITE_CONTRACT,
  OS_FS_EDIT_CONTRACT,
  OS_FS_PATCH_CONTRACT,
  OS_FS_TRASH_CONTRACT,
  OS_FS_RESTORE_CONTRACT,
  OS_FS_LOCATE_PROJECT_CONTRACT,
];

const unexpected = (): never => { throw new Error("Catalog assembly must not execute an external operation"); };
const browser: BrowserBackend = {
  ensureReady: async () => unexpected(), shutdown: async () => {},
  snapshot: async () => unexpected(), hasRef: async () => unexpected(),
  navigate: async () => unexpected(), click: async () => unexpected(),
  type: async () => unexpected(), search: async () => unexpected(),
  tabs: async () => unexpected(), scroll: async () => unexpected(),
};

class RecordingRegistry extends ToolRegistry {
  readonly registrations: ToolDefinition[] = [];
  override register(definition: ToolDefinition): void {
    this.registrations.push(definition); // Before Map.set can hide a duplicate.
    super.register(definition);
  }
}

// These are differences between catalog surfaces, not blanket exclusions.
const TERMINALS = {
  reply: { owner: "tools/conversation + OpenAI adapter", reason: "Native adapter supplies the turn terminal even when a role hides its descriptor; its wire schema overrides the catalog schema" },
  finish: { owner: "tools/finish + OpenAI adapter", reason: "Native adapter supplies the session terminal even when a role hides its descriptor; its wire schema overrides the catalog schema" },
};
const CONDITIONAL = {
  registration: { owner: "runtime/bootstrap", reason: "Browser, memory, tasks and vision builders follow their enabled gates" },
  availability: { owner: "runtime/filter-disabled-tools", reason: "Web, email, GitHub and fusion definitions stay registered while unavailable descriptors are hidden" },
  mcp: { owner: "mcp/McpManager + runtime/bootstrap", reason: "Meta tools are registered once; server-qualified tools and external schemas belong to the live catalog" },
  wrapper: { owner: "tools/read-scope/confine-reads", reason: "The protection phase replaces selected definitions without changing their catalog metadata" },
};

// Existing catalog debt, independently captured from the immutable pre-05l graph.
// Both copies affect stable-prefix bytes; discovery is last-wins and native wire is first-wins.
// This bounded compatibility ledger grants no permission for another duplicate.
const KNOWN_DESCRIPTOR_DUPLICATES = new Map<string, { indices: number[]; fingerprints: string[]; owner: string; reason: string }>([
  ["os.git.push", { indices: [33, 43], fingerprints: ["093e96423e4d2e226a0c520bea7398f10f6f9fc22a02b382e57191b57412e67f", "9d8ae0fa05777782f8218cfa69b6661e2c85c0a191406ee581cc52a9e2602a48"], owner: "prompt/default-tool-descriptors-a", reason: "Preserve shipped prefix entries and first-wire/last-discovery resolution during the mechanical move" }],
  ["os.git.commit", { indices: [32, 47], fingerprints: ["95ef51ed40cc6ce5a762a7138f9f840dfa3e932b6f0f01bea11dd81a02fed773", "76a621b86514c6c0de7bdc5987127ccb26ebec8534bdf273cf46a5fb2f83227e"], owner: "prompt/default-tool-descriptors-a", reason: "Preserve shipped prefix entries and first-wire/last-discovery resolution during the mechanical move" }],
  ["os.git.checkout", { indices: [31, 48], fingerprints: ["838fd065d1f322f4948821d4e787582d513bd86336b003f3e7143142080030ce", "981cfd260f769a8d38355113818ad41766037e142d4e5f5bbe37fff689ee2e48"], owner: "prompt/default-tool-descriptors-a", reason: "Preserve shipped prefix entries and first-wire/last-discovery resolution during the mechanical move" }],
]);

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Inventory the private map without exporting a new production enumeration API. */
function schemaInventory(file: string, variable: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const imports = new Map<string, { file: string; exported: string }>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      imports.set(binding.name.text, {
        file: resolve(dirname(file), statement.moduleSpecifier.text.replace(/\.js$/, ".ts")),
        exported: binding.propertyName?.text ?? binding.name.text,
      });
    }
  }
  const fail = (node: ts.Node): never => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    throw new Error(`Unsupported schema inventory expression: ${file}:${position.line + 1}: ${node.getText(source)}`);
  };
  const findInitializer = (tree: ts.SourceFile, name: string): ts.Expression => {
    for (const statement of tree.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration.initializer;
      }
    }
    throw new Error(`Missing schema inventory owner: ${name}`);
  };
  const canonicalName = (node: ts.Expression): string => {
    if (ts.isStringLiteral(node)) return node.text;
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "name" || !ts.isIdentifier(node.expression)) return fail(node);
    const imported = imports.get(node.expression.text);
    if (!imported) return fail(node);
    const tree = ts.createSourceFile(imported.file, readFileSync(imported.file, "utf8"), ts.ScriptTarget.Latest, true);
    let initializer = findInitializer(tree, imported.exported);
    while (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
    if (!ts.isObjectLiteralExpression(initializer)) return fail(node);
    for (const property of initializer.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "name") {
        const value = ts.isIdentifier(property.initializer) ? findInitializer(tree, property.initializer.text) : property.initializer;
        if (ts.isStringLiteral(value)) return value.text;
      }
    }
    return fail(node);
  };
  let initializer = findInitializer(source, variable);
  if (ts.isNewExpression(initializer)) {
    if (!ts.isIdentifier(initializer.expression) || initializer.expression.text !== "Map" || initializer.arguments?.length !== 1) return fail(initializer);
    initializer = initializer.arguments[0]!;
  }
  if (!ts.isArrayLiteralExpression(initializer)) return fail(initializer);
  return initializer.elements.flatMap((element) => {
    if (ts.isSpreadElement(element)) {
      if (!ts.isIdentifier(element.expression)) return fail(element);
      const imported = imports.get(element.expression.text);
      if (!imported) return fail(element);
      return schemaInventory(imported.file, imported.exported);
    }
    if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) return fail(element);
    const key = element.elements[0]!;
    if (!ts.isExpression(key)) return fail(key);
    return [canonicalName(key)];
  });
}

type GateDescriptor = Omit<ToolDescriptor, "tier"> & { tier?: string };
interface Catalog {
  descriptors: readonly GateDescriptor[];
  registrations: readonly ToolDefinition[];
  schemaNames: readonly string[];
  classes: ReadonlyMap<string, string>;
}
function conformanceErrors(catalog: Catalog): string[] {
  const errors: string[] = [];
  const admittedDebt = new Set<string>();
  for (const [name, debt] of KNOWN_DESCRIPTOR_DUPLICATES) {
    const entries = catalog.descriptors.flatMap((descriptor, index) => descriptor.name === name ? [{ descriptor, index }] : []);
    const indices = entries.map((entry) => entry.index);
    const fingerprints = entries.map((entry) => createHash("sha256").update(JSON.stringify(entry.descriptor)).digest("hex"));
    if (JSON.stringify(indices) === JSON.stringify(debt.indices) && JSON.stringify(fingerprints) === JSON.stringify(debt.fingerprints)) admittedDebt.add(name);
    else errors.push(`changed known descriptor debt: ${name}`);
  }
  const unique = (facet: string, names: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    for (const name of names) { if (seen.has(name) && !(facet === "descriptor" && admittedDebt.has(name))) errors.push(`duplicate ${facet}: ${name}`); seen.add(name); }
    return seen;
  };
  const descriptors = unique("descriptor", catalog.descriptors.map((d) => d.name));
  const registrations = unique("registration", catalog.registrations.map((d) => d.name));
  const schemas = unique("schema", catalog.schemaNames);
  const terminals = new Set(Object.keys(TERMINALS));
  const expected = new Set([...descriptors, ...terminals]);
  for (const name of expected) {
    if (!registrations.has(name)) errors.push(`missing registration: ${name}`);
    if (!schemas.has(name)) errors.push(`missing schema: ${name}`);
    if (!catalog.classes.has(name) || !["pure_read", "fs_write", "browser", "memory_write", "tasks_write", "vision", "approval_gated", "terminal"].includes(catalog.classes.get(name) ?? "")) errors.push(`missing class: ${name}`);
  }
  for (const [facet, names] of [["registration", registrations], ["schema", schemas], ["class", catalog.classes.keys()]] as const) {
    for (const name of names) if (!expected.has(name)) errors.push(`orphan ${facet}: ${name}`);
  }
  for (const definition of catalog.registrations) {
    if (definition.description.length === 0) errors.push(`empty description: ${definition.name}`);
  }
  // Canonical semantic oracle is deliberately bounded to the 13 filesystem contracts.
  // Other built-ins have no canonical owner yet: presence/formats do not prove their semantics.
  for (const contract of CORE_CONTRACTS) {
    const definition = catalog.registrations.find((item) => item.name === contract.name);
    const descriptor = catalog.descriptors.find((item) => item.name === contract.name);
    if (definition && (definition.description !== contract.description || definition.readonly !== contract.readonly)) errors.push(`core registration mismatch: ${contract.name}`);
    if (descriptor) {
      const { argsJsonSchema, ...fields } = descriptor;
      if (JSON.stringify(fields) !== JSON.stringify(contract.descriptor)) errors.push(`core descriptor mismatch: ${contract.name}`);
      if (JSON.stringify(argsJsonSchema) !== JSON.stringify(contract.argsJsonSchema)) errors.push(`core schema mismatch: ${contract.name}`);
    }
    if (catalog.classes.get(contract.name) !== contract.resourceClass) errors.push(`core class mismatch: ${contract.name}`);
  }
  for (const descriptor of catalog.descriptors) {
    if (descriptor.tier !== undefined && descriptor.tier !== "frequent" && descriptor.tier !== "rare") errors.push(`invalid tier: ${descriptor.name}`);
    const schema = descriptor.argsJsonSchema;
    if (!schema || schema.type !== "object" || !isRecord(schema.properties) || !Array.isArray(schema.required) || !schema.required.every((key: unknown) => typeof key === "string" && Object.hasOwn(schema.properties ?? {}, key)) || schema.additionalProperties !== false) errors.push(`invalid schema: ${descriptor.name}`);
    if (schema !== getDefaultArgsJsonSchema(descriptor.name)) errors.push(`detached schema: ${descriptor.name}`);
  }
  return errors;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const names = (items: readonly { name: string }[]) => items.map((item) => item.name);
const gates: ToolGateConfig = {
  browser: { enabled: true }, web: { search: { enabled: true } },
  vision: { enabled: true, providerAvailable: true },
  memory: { profile: { enabled: true }, notes: { enabled: true }, lessons: { enabled: true }, procedures: { enabled: true } },
  tasks: { agentToolsEnabled: true }, email: { available: true }, mcp: { enabled: true }, github: { connected: true }, fusion: { enabled: true },
};

let directory: string;
let registry: RecordingRegistry;
let profileStore: ProfileStore;
let notesStore: MemoryStore;
let lessonStore: LessonStore;
let procedureStore: ProcedureStore;
let taskStore: TaskStore;
let manager: McpManager;
let shellJobs: ShellJobRegistry;
let taskRunner: TaskRunner;
const dangerous = { approvals: new ApprovalGate({ emit: unexpected }), approvalRequired: false };

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "atomic-tool-conformance-"));
  profileStore = new ProfileStore({ dbFile: join(directory, "profile.sqlite") });
  notesStore = new MemoryStore({ dbFile: join(directory, "notes.sqlite"), maxEntries: 10 });
  lessonStore = new LessonStore({ dbFile: join(directory, "lessons.sqlite") });
  procedureStore = new ProcedureStore({ dbFile: join(directory, "procedures.sqlite") });
  taskStore = new TaskStore({ dbFile: join(directory, "tasks.sqlite") });
  taskRunner = new TaskRunner({ store: taskStore, runtime: { runTurn: async () => unexpected() }, sessionLoader: { load: () => null }, defaultMaxSteps: 1, backoff: { initialMs: 1, maxMs: 1 }, enabled: false, runOnCreate: false });
  shellJobs = new ShellJobRegistry();
  registry = new RecordingRegistry();
  registry.register(finishTool);
  registry.register(replyTool);
  for (const definition of buildBrowserTools(browser, dangerous)) registry.register(definition);
  registerOsTools(registry, { ...dangerous, shellJobs, listRecentSessionDirs: () => [], config: {
    http: USER_CONFIG_DEFAULTS.http, projects: USER_CONFIG_DEFAULTS.projects, tools: USER_CONFIG_DEFAULTS.tools,
    web: { fetch: USER_CONFIG_DEFAULTS.web.fetch, search: { ...USER_CONFIG_DEFAULTS.web.search, provider: "duckduckgo", persistCache: false } },
  } });
  registerVerifyTools(registry, { ...dangerous, config: { browser: { enabled: true, channel: "chromium", headless: true, cdpUrl: null, executablePath: null, noSandbox: false, launchTimeoutMs: 1000 } } });
  registerGithubTools(registry, dangerous);
  registerSkillTools(registry, new SkillRegistry({ globalDir: join(directory, "skills"), projectDir: null }), dangerous);
  registry.register(buildToolViewTool());
  registerMemoryTools(registry, memoryOptions(true));
  registerTaskTools(registry, taskOptions(true));
  registerVisionTools(registry, { enabled: true, provider: () => undefined, maxImagesPerCall: 1, maxImageBytes: 1024 });
  registry.register(buildFusionDelegateTool({ ...dangerous, slotManager: { poolSize: () => 1 }, resolveRunMode: unexpected, workerSupportsSlotAffinity: () => false, warmWorkerBackend: async () => unexpected(), outputCharCap: 1000, logger: new StructuredLogger({ level: "error", sinks: [] }), runTurn: async () => unexpected(), createEphemeralSession: unexpected, emitEvent: unexpected, workingDir: directory }));
  manager = new McpManager([], { toolRegistry: registry });
  for (const definition of [buildMcpResourceListTool(manager), buildMcpResourceReadTool(manager), buildMcpPromptListTool(manager), buildMcpPromptGetTool(manager)]) registry.register(definition);
});
afterAll(async () => {
  await manager?.shutdown();
  shellJobs?.endAll();
  // No scheduler or TaskRunner drain is started; all owned SQLite handles close.
  for (const store of [taskStore, procedureStore, lessonStore, notesStore, profileStore]) store?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function memoryOptions(enabled: boolean) {
  return { profileStore, profileEnabled: enabled, notesStore, notesEnabled: enabled, notesRecallDefaultK: 1, notesMaxContentChars: 1000, lessonStore, lessonsEnabled: enabled, procedureStore, proceduresEnabled: enabled };
}
function taskOptions(enabled: boolean) {
  return { taskStore, taskRunner, createSession: unexpected, agentToolsEnabled: enabled, defaultMaxAttempts: 1, defaultListLimit: 10 };
}
function catalog(): Catalog {
  return { descriptors: DEFAULT_TOOL_DESCRIPTORS, registrations: registry.registrations, schemaNames: schemaInventory(join(sourceRoot, "prompt/default-tool-args-schemas.ts"), "DEFAULT_TOOL_ARGS_SCHEMAS"), classes: new Map(Object.entries(listKnownToolResourceClasses())) };
}

describe("whole built-in tool catalog conformance", () => {
  it("joins every real static registrar with descriptors, the private schema inventory and static taxonomy", () => {
    expect(conformanceErrors(catalog())).toEqual([]);
    for (const [name, exception] of Object.entries(TERMINALS)) {
      expect(exception.owner.length).toBeGreaterThan(0);
      expect(exception.reason.length).toBeGreaterThan(0);
      expect(registry.has(name)).toBe(true);
      expect(names(DEFAULT_TOOL_DESCRIPTORS)).toContain(name);
      expect(resourceClassFor(name)).toBe("terminal");
    }
    expect(DEFAULT_TOOL_DESCRIPTORS).toHaveLength(88);
    expect(new Set(names(DEFAULT_TOOL_DESCRIPTORS)).size).toBe(85);
    for (const [name, debt] of KNOWN_DESCRIPTOR_DUPLICATES) {
      expect(debt.owner).not.toBe(""); expect(debt.reason).not.toBe("");
      const copies = DEFAULT_TOOL_DESCRIPTORS.filter((descriptor) => descriptor.name === name);
      expect(copies).toHaveLength(2);
      expect(getToolDescriptorByName(name)).toBe(copies[1]);
    }
    expect(registry.list()).toHaveLength(registry.registrations.length);
    for (const definition of registry.registrations) {
      expect(typeof definition.readonly).toBe("boolean");
      expect(definition.description.length, definition.name).toBeGreaterThan(0);
      expect(resourceClassFor(definition.name), definition.name).not.toBe("unknown");
    }
    expect(resourceClassFor("conformance.unknown")).toBe("unknown");
  });

  it("fails independently for duplicate/missing/orphan facets, schema drift and invalid tiers", () => {
    const base = catalog();
    const descriptor = base.descriptors[0]!;
    const definition = base.registrations.find((entry) => entry.name === descriptor.name)!;
    const mutations: Array<{ mutate: (input: Catalog) => Catalog; expected: string }> = [
      { mutate: (input) => ({ ...input, registrations: [...input.registrations, definition] }), expected: `duplicate registration: ${definition.name}` },
      { mutate: (input) => ({ ...input, descriptors: [...input.descriptors, descriptor] }), expected: `duplicate descriptor: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, schemaNames: [...input.schemaNames, descriptor.name] }), expected: `duplicate schema: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, registrations: input.registrations.filter((item) => item.name !== descriptor.name) }), expected: `missing registration: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, schemaNames: input.schemaNames.filter((name) => name !== descriptor.name) }), expected: `missing schema: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, classes: new Map([...input.classes].filter(([name]) => name !== descriptor.name)) }), expected: `missing class: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, registrations: [...input.registrations, { ...definition, name: "orphan" }] }), expected: "orphan registration: orphan" },
      { mutate: (input) => ({ ...input, schemaNames: [...input.schemaNames, "orphan"] }), expected: "orphan schema: orphan" },
      { mutate: (input) => ({ ...input, classes: new Map([...input.classes, ["orphan", "pure_read"]]) }), expected: "orphan class: orphan" },
      { mutate: (input) => ({ ...input, descriptors: input.descriptors.map((item) => item === descriptor ? { ...item, tier: "unrecognized" } : item) }), expected: `invalid tier: ${descriptor.name}` },
      { mutate: (input) => ({ ...input, descriptors: input.descriptors.map((item) => item === descriptor ? { ...item, argsJsonSchema: { type: "object", properties: {}, required: ["absent"], additionalProperties: true } } : item) }), expected: `invalid schema: ${descriptor.name}` },
    ];
    expect(conformanceErrors({ ...base, descriptors: [...base.descriptors, { ...descriptor, name: "orphan" }] })).toContain("missing registration: orphan");
    const known = base.descriptors.find((item) => item.name === "os.git.push")!;
    expect(conformanceErrors({ ...base, descriptors: base.descriptors.map((item) => item === known ? { ...item, summary: "changed known copy" } : item) })).toContain("changed known descriptor debt: os.git.push");
    expect(conformanceErrors({ ...base, descriptors: [...base.descriptors, known] })).toContain("duplicate descriptor: os.git.push");
    expect(conformanceErrors({ ...base, descriptors: base.descriptors.filter((item) => item.name !== "os.git.push") })).toContain("changed known descriptor debt: os.git.push");
    expect(conformanceErrors({ ...base, classes: new Map([...base.classes, [descriptor.name, "unrecognized"]]) })).toContain(`missing class: ${descriptor.name}`);
    for (const mutation of mutations) expect(conformanceErrors(mutation.mutate(base))).toContain(mutation.expected);
    expect(conformanceErrors(base)).toEqual([]); // Fixtures never mutate shipped references.
  });

  it("detects semantic drift on every canonical filesystem facet", () => {
    const base = catalog();
    const name = "os.fs.hash";
    const descriptor = base.descriptors.find((item) => item.name === name)!;
    const definition = base.registrations.find((item) => item.name === name)!;
    const schema = descriptor.argsJsonSchema;
    if (!schema || !isRecord(schema.properties)) throw new Error("Canonical hash schema is absent");
    const properties = schema.properties;
    const algorithm = properties.algorithm;
    if (!isRecord(algorithm)) throw new Error("Canonical algorithm enum is absent");
    const schemaMutations = [
      { ...schema, required: [] },
      { ...schema, additionalProperties: true },
      { ...schema, properties: { ...properties, algorithm: { ...algorithm, enum: ["sha1"] } } },
      { additionalProperties: schema.additionalProperties, required: schema.required, properties, type: schema.type },
    ];
    for (const changed of schemaMutations) {
      expect(conformanceErrors({ ...base, descriptors: base.descriptors.map((item) => item === descriptor ? { ...item, argsJsonSchema: changed } : item) })).toContain(`core schema mismatch: ${name}`);
    }
    for (const changed of [{ ...definition, readonly: !definition.readonly }, { ...definition, description: "Incorrect execution description" }]) {
      expect(conformanceErrors({ ...base, registrations: base.registrations.map((item) => item === definition ? changed : item) })).toContain(`core registration mismatch: ${name}`);
    }
    for (const changed of [{ ...descriptor, summary: "Incorrect teaching" }, { ...descriptor, argsSchema: "{ unrelated: number }" }, { ...descriptor, tier: descriptor.tier === "rare" ? "frequent" : "rare" }]) {
      expect(conformanceErrors({ ...base, descriptors: base.descriptors.map((item) => item === descriptor ? changed : item) })).toContain(`core descriptor mismatch: ${name}`);
    }
    expect(conformanceErrors({ ...base, classes: new Map([...base.classes, [name, "approval_gated"]]) })).toContain(`core class mismatch: ${name}`);
    expect(conformanceErrors(base)).toEqual([]);
  });

  it("rejects unsupported schema key syntax with a source location", () => {
    const file = join(directory, "unsupported-schema.ts");
    writeFileSync(file, 'const CATALOG = new Map([["dynamic" + Date.now(), {}]]);');
    expect(() => schemaInventory(file, "CATALOG")).toThrow(/Unsupported schema inventory expression: .*unsupported-schema\.ts:1/);
  });

  it("pins each conditional registrar and descriptor-only availability gate", () => {
    for (const exception of Object.values(CONDITIONAL)) { expect(exception.owner).not.toBe(""); expect(exception.reason).not.toBe(""); }
    const disabled = new RecordingRegistry();
    registerMemoryTools(disabled, memoryOptions(false));
    registerTaskTools(disabled, taskOptions(false));
    registerVisionTools(disabled, { enabled: false, provider: () => undefined, maxImagesPerCall: 1, maxImageBytes: 1024 });
    registerVisionTools(disabled, { enabled: true, provider: undefined, maxImagesPerCall: 1, maxImageBytes: 1024 });
    expect(disabled.registrations).toEqual([]);
    const families = [
      { group: GATED_TOOL_NAMES.browser, next: { ...gates, browser: { enabled: false } } },
      { group: GATED_TOOL_NAMES.webSearch, next: { ...gates, web: { search: { enabled: false } } } },
      { group: GATED_TOOL_NAMES.vision, next: { ...gates, vision: { enabled: true, providerAvailable: false } } },
      ...Object.entries(gates.memory).map(([key]) => ({ group: key === "profile" ? GATED_TOOL_NAMES.memoryProfile : key === "notes" ? GATED_TOOL_NAMES.memoryNotes : key === "lessons" ? GATED_TOOL_NAMES.memoryLessons : GATED_TOOL_NAMES.memoryProcedures, next: { ...gates, memory: { ...gates.memory, [key]: { enabled: false } } } })),
      { group: GATED_TOOL_NAMES.tasks, next: { ...gates, tasks: { agentToolsEnabled: false } } },
      { group: GATED_TOOL_NAMES.email, next: { ...gates, email: { available: false } } },
      { group: GATED_TOOL_NAMES.mcp, next: { ...gates, mcp: { enabled: false } } },
      { group: GATED_TOOL_NAMES.github, next: { ...gates, github: { connected: false } } },
      { group: GATED_TOOL_NAMES.fusion, next: { ...gates, fusion: { enabled: false } } },
    ];
    for (const family of families) {
      expect(names(filterToolDescriptorsByConfig(DEFAULT_TOOL_DESCRIPTORS, family.next))).toEqual(names(DEFAULT_TOOL_DESCRIPTORS).filter((name) => !new Set<string>(family.group).has(name)));
      for (const name of family.group) expect(registry.has(name), name).toBe(true);
    }
    const perFamily = new RecordingRegistry();
    registerMemoryTools(perFamily, memoryOptions(true));
    expect(names(perFamily.registrations)).toEqual([...GATED_TOOL_NAMES.memoryProfile, ...GATED_TOOL_NAMES.memoryNotes, ...GATED_TOOL_NAMES.memoryLessons, ...GATED_TOOL_NAMES.memoryProcedures]);
    const tasks = new RecordingRegistry(); registerTaskTools(tasks, taskOptions(true));
    expect(new Set(names(tasks.registrations))).toEqual(new Set(GATED_TOOL_NAMES.tasks));
    expect(new Set(names(buildBrowserTools(browser, dangerous)))).toEqual(new Set(GATED_TOOL_NAMES.browser));
  });

  it("keeps role order, loaded-tool unions, native wire names and grammar membership aligned", async () => {
    const view = buildToolViewTool();
    for (const role of TOOL_ROLES) {
      const partition = partitionByRole(role, DEFAULT_TOOL_DESCRIPTORS);
      expect(partition.inRole).toEqual(DEFAULT_TOOL_DESCRIPTORS.filter((item) => roleAdmits(role, item.name)));
      expect(partition.outside).toEqual(DEFAULT_TOOL_DESCRIPTORS.filter((item) => !roleAdmits(role, item.name)));
      const loaded = new Set(partition.outside.map((item) => item.name));
      expect(descriptorsForRole(role, DEFAULT_TOOL_DESCRIPTORS, loaded)).toEqual(DEFAULT_TOOL_DESCRIPTORS);
      const visible = descriptorsForRole(role, DEFAULT_TOOL_DESCRIPTORS, new Set());
      const wireNames = descriptorsToOpenAiTools(visible).map((tool) => {
        if (!isRecord(tool.function) || typeof tool.function.name !== "string") throw new Error("Unsupported native tool wire envelope");
        return tool.function.name;
      });
      expect(wireNames).toEqual([...new Set([...names(visible).map(nameEscape), "reply", "finish"])]);
      expect(grammarToolNames(buildGrammarForTools("tool-name ::= old\n", names(visible)))).toEqual([...new Set([...names(visible), "reply"])].sort());
      for (const descriptor of DEFAULT_TOOL_DESCRIPTORS) {
        const operation = view.run({ name: descriptor.name }, { workingDir: directory, sessionId: "catalog", stepIndex: 0, signal: new AbortController().signal, toolRole: role });
        const discoveryDescriptor = getToolDescriptorByName(descriptor.name);
        if (!discoveryDescriptor) throw new Error(`Descriptor disappeared from discovery: ${descriptor.name}`);
        if (discoveryDescriptor.tier === "rare" || !roleAdmits(role, descriptor.name)) {
          const result = await operation;
          expect(result.details?.toolLoaded).toMatchObject({ name: descriptor.name, argsSchema: discoveryDescriptor.argsSchema, source: "explicit" });
        } else await expect(operation).rejects.toThrow("not in the # extras list");
      }
    }
    expect(roleAdmits("builder", "os.fs.locate_project")).toBe(false);
    expect(roleAdmits("builder", "os.fs.trash")).toBe(false);
    for (const name of ["os.fs.write", "os.fs.edit", "os.fs.patch", "os.fs.restore"]) expect(roleAdmits("builder", name)).toBe(true);
    for (const name of ["os.fs.read", "os.fs.hash", "os.fs.diff", "os.fs.watch", "os.fs.locate_project"]) expect(roleAdmits("orchestrator", name)).toBe(true);
  });

  it("records read-scope replacements as a separate metadata-preserving phase", () => {
    const scoped = new RecordingRegistry();
    for (const definition of registry.registrations) scoped.register(definition);
    const firstPhase = scoped.registrations.length;
    const confined = confineReads(scoped, { grantedDirs: () => [], readScope: () => "working-dir", approvals: dangerous });
    expect(new Set(confined)).toEqual(new Set([...READ_TOOL_TARGETS.keys(), "os.shell.run"]));
    const replacements = scoped.registrations.slice(firstPhase);
    expect(names(replacements)).toEqual(confined);
    for (const definition of replacements) {
      const original = registry.get(definition.name);
      expect(definition).not.toBe(original);
      expect(definition.run).not.toBe(original.run);
      expect({ ...definition, run: original.run }).toEqual(original);
    }
    expect(READ_TOOL_TARGETS.has("os.fs.locate_project")).toBe(false);
    expect(conformanceErrors({ ...catalog(), registrations: scoped.registrations.slice(0, firstPhase) })).toEqual([]);
    confineReads(scoped, { grantedDirs: () => [], readScope: () => "working-dir", approvals: dangerous });
    expect(scoped.registrations).toHaveLength(firstPhase + replacements.length);
  });

  it("keeps MCP schemas external and owns dynamic registration, restart and resolver teardown", async () => {
    const dynamicRegistry = new RecordingRegistry();
    const schema = { type: "object", properties: { arbitrary: { type: "string" } }, additionalProperties: true };
    const meta: McpToolMeta = { server: "catalog", rawName: "nested.tool", qualifiedName: "mcp.catalog.nested.tool", description: "Externally owned tool", inputSchema: schema, annotations: { destructiveHint: false }, resourceClass: "approval_gated" };
    let tools = [meta];
    // Only the transport boundary is replaced; the actual manager and actual client instances own lifecycle.
    const connect = vi.spyOn(McpClient.prototype, "connect").mockResolvedValue(undefined);
    const getCatalog = vi.spyOn(McpClient.prototype, "getCatalog").mockImplementation(() => ({ server: "catalog", tools, resources: [], prompts: [] }));
    const close = vi.spyOn(McpClient.prototype, "close");
    const dynamicManager = new McpManager([{ name: "catalog", enabled: true, trust: "pure_read", transport: { kind: "stdio", command: "must-not-start" } }], { toolRegistry: dynamicRegistry, dangerous });
    try {
      await dynamicManager.start();
      expect(connect).toHaveBeenCalledTimes(1);
      expect(dynamicManager.listStatuses()[0]?.state).toBe("up");
      expect(dynamicRegistry.registrations).toHaveLength(1);
      const definition = dynamicRegistry.get(meta.qualifiedName);
      const discovered = dynamicManager.listAllToolMeta()[0];
      if (!discovered) throw new Error("Manager lost its external catalog");
      const descriptor = buildMcpToolDescriptor(discovered);
      expect(descriptor.argsJsonSchema).toBe(schema);
      expect(descriptor.tier).toBe("frequent");
      expect(definition.readonly).toBe(true);
      expect(resourceClassFor(meta.qualifiedName)).toBe("pure_read");
      expect(resourceClassFor("mcp.unknown.tool")).toBe("approval_gated");
      expect(resourceClassFor("mcp.resource.list")).toBe("pure_read"); // Static taxonomy wins.
      expect(createMcpResourceClassResolver(new Map())("mcp.resource.list")).toBe("approval_gated");
      tools = [{ ...meta, description: "Refreshed external tool" }];
      expect(await dynamicManager.restartServer("catalog")).toBe(true);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledTimes(1);
      expect(dynamicRegistry.get(meta.qualifiedName)).not.toBe(definition);
      expect(dynamicRegistry.get(meta.qualifiedName).description).toBe("Refreshed external tool");
      expect(dynamicRegistry.registrations).toHaveLength(2);
      expect(dynamicRegistry.list()).toHaveLength(1);
      await dynamicManager.shutdown();
      expect(dynamicRegistry.has(meta.qualifiedName)).toBe(false);
      expect(resourceClassFor(meta.qualifiedName)).toBe("unknown");
    } finally {
      try { await dynamicManager.shutdown(); } finally {
        connect.mockRestore(); getCatalog.mockRestore(); close.mockRestore(); setDynamicResourceClassResolver(null);
      }
    }
  });
});
