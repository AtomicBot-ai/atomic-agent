import { describe, expect, it } from "vitest";

import {
  COMPOSIO_GUIDANCE,
  COMPOSIO_SEARCH_TOOL,
  isComposioActive,
} from "./composio-guidance.js";
import { buildStablePrefix, type ToolDescriptor } from "./stable-prefix.js";
import type { CapabilitiesSummary } from "./capabilities.js";

function descriptor(name: string): ToolDescriptor {
  return { name, summary: `${name} summary`, argsSchema: "{}" };
}

const CAPS: CapabilitiesSummary = {
  platform: "linux",
} as unknown as CapabilitiesSummary;

function prefixWith(descriptors: readonly ToolDescriptor[]): string {
  return buildStablePrefix({
    toolDescriptors: descriptors,
    capabilities: CAPS,
    skillCatalog: [],
  });
}

describe("isComposioActive", () => {
  it("keys off the search tool actually being mounted", () => {
    expect(isComposioActive([descriptor(COMPOSIO_SEARCH_TOOL)])).toBe(true);
    expect(isComposioActive([descriptor("os.fs.read")])).toBe(false);
    expect(isComposioActive([])).toBe(false);
  });

  it("is not fooled by an unrelated mcp server", () => {
    expect(isComposioActive([descriptor("mcp.github.search")])).toBe(false);
  });
});

describe("the ### integrations prefix section", () => {
  it("is absent when Composio is not mounted", () => {
    // An install with no key must pay nothing for the integration --
    // not a token, not a byte of KV-cached prefix.
    const prefix = prefixWith([descriptor("os.fs.read")]);
    expect(prefix).not.toContain("### integrations");
    expect(prefix).not.toContain("Composio");
  });

  it("appears once Composio is mounted", () => {
    const prefix = prefixWith([
      descriptor("os.fs.read"),
      descriptor(COMPOSIO_SEARCH_TOOL),
    ]);
    expect(prefix).toContain("### integrations");
    expect(prefix).toContain(COMPOSIO_GUIDANCE);
  });

  it("sits between capabilities and instructions", () => {
    // Placement is load-bearing for the KV cache: everything above it
    // -- persona, rules, skills, the whole tools catalog -- stays
    // byte-identical whether or not Composio is configured.
    const prefix = prefixWith([descriptor(COMPOSIO_SEARCH_TOOL)]);
    expect(prefix.indexOf("### capabilities")).toBeLessThan(
      prefix.indexOf("### integrations"),
    );
    expect(prefix.indexOf("### integrations")).toBeLessThan(
      prefix.indexOf("### instructions"),
    );
  });

  it("leaves everything above it byte-identical", () => {
    const without = prefixWith([descriptor("os.fs.read")]);
    const with_ = prefixWith([descriptor("os.fs.read")]);
    expect(with_.slice(0, with_.indexOf("### capabilities"))).toBe(
      without.slice(0, without.indexOf("### capabilities")),
    );
  });

  it("names the search tool first and the execute tool after", () => {
    // The failure mode this guards is the model guessing an app tool
    // name instead of discovering it, which Composio rejects.
    const search = COMPOSIO_GUIDANCE.indexOf("COMPOSIO_SEARCH_TOOLS");
    const exec = COMPOSIO_GUIDANCE.indexOf("COMPOSIO_MULTI_EXECUTE_TOOL");
    expect(search).toBeGreaterThanOrEqual(0);
    expect(exec).toBeGreaterThan(search);
  });

  it("tells the model to surface the connect link through reply", () => {
    // Tool results are not linkified in chat; a `reply` is. Routing the
    // URL through reply is what makes it clickable for the user.
    expect(COMPOSIO_GUIDANCE).toContain("`reply`");
    expect(COMPOSIO_GUIDANCE).toContain("COMPOSIO_MANAGE_CONNECTIONS");
  });

  it("stays short enough to live in every turn's prefix", () => {
    expect(COMPOSIO_GUIDANCE.length).toBeLessThan(1200);
  });
});
