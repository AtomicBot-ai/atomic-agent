import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { disableLinearChannel, findLinearUserByEmail, writeLinearChannelConfig } from "./linear-setup.js";

function configFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "linear-setup-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe("writeLinearChannelConfig (ATO-2464)", () => {
  it("writes channels.linear and keeps the rest of the file and other options", () => {
    const path = configFile({ futureKey: { kept: 1 }, channels: { linear: { enabled: false, ownerIds: [], options: { port: 4000 } } } });
    writeLinearChannelConfig(path, { enabled: true, ownerIds: ["u1"], mode: "poll", mention: "agent" });
    const tree = JSON.parse(readFileSync(path, "utf8"));
    expect(tree.futureKey).toEqual({ kept: 1 });
    expect(tree.channels.linear).toEqual({ enabled: true, ownerIds: ["u1"], options: { port: 4000, mode: "poll", mention: "agent" } });
  });

  it("creates the block in a file without one, and --off only flips enabled", () => {
    const path = configFile({});
    expect(disableLinearChannel(path)).toBe(false);
    writeLinearChannelConfig(path, { enabled: true, ownerIds: ["u1"], mode: "webhook" });
    expect(disableLinearChannel(path)).toBe(true);
    const linear = JSON.parse(readFileSync(path, "utf8")).channels.linear;
    expect(linear).toEqual({ enabled: false, ownerIds: ["u1"], options: { mode: "webhook" } });
  });
});

describe("findLinearUserByEmail", () => {
  it("returns the first matching user or null", async () => {
    const query = vi.fn().mockResolvedValueOnce({ users: { nodes: [{ id: "u9", name: "Nadia" }] } }).mockResolvedValueOnce({ users: { nodes: [] } });
    expect(await findLinearUserByEmail({ query }, " nadia@example.com ")).toEqual({ id: "u9", name: "Nadia" });
    expect(query.mock.calls[0]![1]).toEqual({ email: "nadia@example.com" });
    expect(await findLinearUserByEmail({ query }, "x@y.z")).toBeNull();
  });
});
