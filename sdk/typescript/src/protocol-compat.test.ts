import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HOST_REQUEST_TYPES, SIDECAR_EVENT_TYPES } from "./protocol.js";

// The SDK mirrors the sidecar's wire types instead of importing them (it
// must install on its own). This reads the source of truth and fails when
// the request or event names drift, so the mirror is updated in the same
// change as src/sidecar/sidecar-events.ts.
const SOURCE = fileURLToPath(
  new URL("../../../src/sidecar/sidecar-events.ts", import.meta.url),
);

function unionMembers(source: string, typeName: string): string[] {
  const match = new RegExp(`export type ${typeName} =([^;]+);`).exec(source);
  if (!match?.[1]) throw new Error(`${typeName} not found in sidecar-events.ts`);
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
}

describe("protocol mirror", () => {
  const source = readFileSync(SOURCE, "utf8");

  it("lists the same host request types as the sidecar", () => {
    expect([...HOST_REQUEST_TYPES].sort()).toEqual(
      unionMembers(source, "HostRequestType").sort(),
    );
  });

  it("lists the same event types as the sidecar", () => {
    expect([...SIDECAR_EVENT_TYPES].sort()).toEqual(
      unionMembers(source, "SidecarEventType").sort(),
    );
  });
});
