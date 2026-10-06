import { describe, expect, it } from "vitest";
import { ApprovalGate } from "../../../approval/approval-gate.js";
import { resourceClassFor, type ResourceClass } from "../../../agent/tool-resource-class.js";
import { USER_CONFIG_DEFAULTS } from "../../../config/config-schema.js";
import { getDefaultArgsJsonSchema } from "../../../prompt/default-tool-args-schemas.js";
import { DEFAULT_TOOL_DESCRIPTORS } from "../../../prompt/tool-descriptors.js";
import type { ToolDescriptor } from "../../../prompt/stable-prefix.js";
import { READ_TOOL_TARGETS } from "../../read-scope/read-scope-targets.js";
import { roleAdmits } from "../../tool-roles.js";
import { ToolRegistry, type ToolDefinition } from "../../tool-registry.js";
import { registerOsTools } from "../index.js";
import { OS_FS_HASH_CONTRACT } from "./fs-hash-contract.js";

const HASH_NAME = "os.fs.hash";
const EXPECTED_DESCRIPTOR = {
  name: HASH_NAME,
  summary: "File digest (md5, sha1, sha256, sha512). Read-only, streams.",
  argsSchema: '{ path: string, algorithm?: "md5" | "sha1" | "sha256" | "sha512", encoding?: "hex" | "base64" }',
  tier: "rare",
};
const EXPECTED_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    algorithm: { type: "string", enum: ["md5", "sha1", "sha256", "sha512"] },
    encoding: { type: "string", enum: ["hex", "base64"] },
  },
  required: ["path"],
  additionalProperties: false,
};

interface ContractView {
  descriptors: readonly ToolDescriptor[];
  registrations: readonly ToolDefinition[];
  schema: Record<string, unknown> | undefined;
  resourceClass: ResourceClass;
}

// Keep arrays until after inspection: the real registry's Map intentionally
// supports replacement, so it cannot expose duplicate static registrations.
class RecordingRegistry extends ToolRegistry {
  readonly registrations: ToolDefinition[] = [];

  override register(definition: ToolDefinition): void {
    this.registrations.push(definition);
    super.register(definition);
  }
}

function actualView(): ContractView {
  const registry = new RecordingRegistry();
  registerOsTools(registry, {
    approvals: new ApprovalGate({
      emit: () => { throw new Error("contract inspection must not request approval"); },
    }),
    approvalRequired: false,
    config: {
      http: USER_CONFIG_DEFAULTS.http,
      projects: USER_CONFIG_DEFAULTS.projects,
      tools: USER_CONFIG_DEFAULTS.tools,
      web: {
        fetch: USER_CONFIG_DEFAULTS.web.fetch,
        search: {
          ...USER_CONFIG_DEFAULTS.web.search,
          provider: "duckduckgo",
          persistCache: false,
        },
      },
    },
    listRecentSessionDirs: () => [],
  });
  return {
    descriptors: DEFAULT_TOOL_DESCRIPTORS,
    registrations: registry.registrations,
    schema: getDefaultArgsJsonSchema(HASH_NAME),
    resourceClass: resourceClassFor(HASH_NAME),
  };
}

function inspectHashContract(view: ContractView): string[] {
  const issues: string[] = [];
  const descriptors = view.descriptors.filter((d) => d.name === HASH_NAME);
  const registrations = view.registrations.filter((d) => d.name === HASH_NAME);
  if (descriptors.length === 0) issues.push("missing descriptor");
  if (descriptors.length > 1) issues.push("duplicate descriptor");
  if (registrations.length === 0) issues.push("missing registration");
  if (registrations.length > 1) issues.push("duplicate registration");
  const descriptor = descriptors[0];
  if (descriptor !== undefined) {
    const projection = {
      name: descriptor.name,
      summary: descriptor.summary,
      argsSchema: descriptor.argsSchema,
      tier: descriptor.tier,
    };
    if (JSON.stringify(projection) !== JSON.stringify(OS_FS_HASH_CONTRACT.descriptor)) {
      issues.push("descriptor mismatch");
    }
    if (JSON.stringify(descriptor.argsJsonSchema) !== JSON.stringify(OS_FS_HASH_CONTRACT.argsJsonSchema)) {
      issues.push("descriptor schema mismatch");
    }
  }
  const definition = registrations[0];
  if (definition !== undefined && (
    definition.name !== OS_FS_HASH_CONTRACT.name ||
    definition.description !== OS_FS_HASH_CONTRACT.description ||
    definition.readonly !== OS_FS_HASH_CONTRACT.readonly
  )) {
    issues.push("definition mismatch");
  }
  if (view.schema === undefined) {
    issues.push("missing schema");
  } else if (JSON.stringify(view.schema) !== JSON.stringify(OS_FS_HASH_CONTRACT.argsJsonSchema)) {
    issues.push("schema mismatch");
  }
  if (view.resourceClass !== OS_FS_HASH_CONTRACT.resourceClass) {
    issues.push("resource class mismatch");
  }
  return issues;
}

function hashDescriptor(view: ContractView): ToolDescriptor {
  const descriptor = view.descriptors.find((d) => d.name === HASH_NAME);
  if (descriptor === undefined) throw new Error("hash descriptor fixture is missing");
  return descriptor;
}

function hashDefinition(view: ContractView): ToolDefinition {
  const definition = view.registrations.find((d) => d.name === HASH_NAME);
  if (definition === undefined) throw new Error("hash registration fixture is missing");
  return definition;
}

describe("os.fs.hash contract composition", () => {
  it("preserves the shipped descriptor and JSON schema, rather than letting all consumers drift together", () => {
    expect(OS_FS_HASH_CONTRACT.name).toBe(HASH_NAME);
    expect(OS_FS_HASH_CONTRACT.descriptor).toEqual(EXPECTED_DESCRIPTOR);
    expect(OS_FS_HASH_CONTRACT.argsJsonSchema).toEqual(EXPECTED_SCHEMA);
    expect(OS_FS_HASH_CONTRACT.readonly).toBe(true);
    expect(OS_FS_HASH_CONTRACT.resourceClass).toBe("pure_read");
  });

  it("connects the real descriptor, schema, OS registration and resource class", () => {
    expect(inspectHashContract(actualView())).toEqual([]);
  });

  it("retains explicit role admission and filesystem read-target policy", () => {
    expect(roleAdmits("builder", HASH_NAME)).toBe(true);
    expect(roleAdmits("orchestrator", HASH_NAME)).toBe(true);
    expect(roleAdmits("full", HASH_NAME)).toBe(true);
    const targets = READ_TOOL_TARGETS.get(HASH_NAME);
    if (targets === undefined) throw new Error("hash read-target mapping is missing");
    expect(targets({ path: "a.txt" })).toEqual(["a.txt"]);
    expect(targets({ path: "" })).toEqual([]);
  });

  it("detects a missing descriptor", () => {
    const view = actualView();
    expect(inspectHashContract({ ...view, descriptors: view.descriptors.filter((d) => d.name !== HASH_NAME) })).toEqual(["missing descriptor"]);
  });

  it("detects a duplicate descriptor before building a name map", () => {
    const view = actualView();
    expect(inspectHashContract({ ...view, descriptors: [...view.descriptors, hashDescriptor(view)] })).toEqual(["duplicate descriptor"]);
  });

  it("detects a missing static OS registration", () => {
    const view = actualView();
    expect(inspectHashContract({ ...view, registrations: view.registrations.filter((d) => d.name !== HASH_NAME) })).toEqual(["missing registration"]);
  });

  it("detects a duplicate static registration even though the registry Map replaces it", () => {
    const view = actualView();
    expect(inspectHashContract({ ...view, registrations: [...view.registrations, hashDefinition(view)] })).toEqual(["duplicate registration"]);
  });

  it("detects a missing JSON schema", () => {
    expect(inspectHashContract({ ...actualView(), schema: undefined })).toEqual(["missing schema"]);
  });

  it("detects a schema that no longer requires path", () => {
    expect(inspectHashContract({ ...actualView(), schema: { ...EXPECTED_SCHEMA, required: [] } })).toEqual(["schema mismatch"]);
  });

  it("detects an advertised algorithm outside the runtime's closed set", () => {
    const schema = {
      ...EXPECTED_SCHEMA,
      properties: { ...EXPECTED_SCHEMA.properties, algorithm: { type: "string", enum: ["md5", "sha1", "sha256", "sha512", "whirlpool"] } },
    };
    expect(inspectHashContract({ ...actualView(), schema })).toEqual(["schema mismatch"]);
  });

  it("detects a schema that permits unknown arguments", () => {
    expect(inspectHashContract({ ...actualView(), schema: { ...EXPECTED_SCHEMA, additionalProperties: true } })).toEqual(["schema mismatch"]);
  });

  it.each<ResourceClass>(["unknown", "approval_gated"])("detects the wrong resource class %s", (resourceClass) => {
    expect(inspectHashContract({ ...actualView(), resourceClass })).toEqual(["resource class mismatch"]);
  });

  it("detects changed prompt argument wording", () => {
    const view = actualView();
    const descriptors = view.descriptors.map((d) => d.name === HASH_NAME ? { ...d, argsSchema: "{ path: string }" } : d);
    expect(inspectHashContract({ ...view, descriptors })).toEqual(["descriptor mismatch"]);
  });

  it("detects a descriptor schema override that disagrees with the registered schema", () => {
    const view = actualView();
    const descriptors = view.descriptors.map((d) => d.name === HASH_NAME ? { ...d, argsJsonSchema: { ...EXPECTED_SCHEMA, required: [] } } : d);
    expect(inspectHashContract({ ...view, descriptors })).toEqual(["descriptor schema mismatch"]);
  });

  it("detects a mutating definition hidden behind read-only classification", () => {
    const view = actualView();
    const registrations = view.registrations.map((d) => d.name === HASH_NAME ? { ...d, readonly: false } : d);
    expect(inspectHashContract({ ...view, registrations })).toEqual(["definition mismatch"]);
  });
});
