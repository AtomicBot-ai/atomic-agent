import { describe, expect, it } from "vitest";
import { workerInheritsWorkspace } from "./worker-workspace.js";

describe("workerInheritsWorkspace (ATO-1601)", () => {
  it("a cloud worker always inherits the parent's workspace", () => {
    expect(
      workerInheritsWorkspace({ modelMode: "cloud", sessionDir: "/a", startupDir: "/a" }),
    ).toBe(true);
  });

  it("a local worker in the startup folder keeps the registry's catalog", () => {
    expect(
      workerInheritsWorkspace({ modelMode: "local", sessionDir: "/work/app/", startupDir: "/work/app" }),
    ).toBe(false);
    expect(
      workerInheritsWorkspace({ modelMode: undefined, sessionDir: "/work/app", startupDir: "/work/app" }),
    ).toBe(false);
  });

  it("a local worker gets its own folder's skills once the session moved", () => {
    expect(
      workerInheritsWorkspace({ modelMode: "local", sessionDir: "/work/other", startupDir: "/work/app" }),
    ).toBe(true);
  });
});
