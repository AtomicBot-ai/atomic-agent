import { describe, expect, it } from "vitest";

import type { PersonasConfig } from "./persona-config.js";
import { findProjectBinding, resolvePersona } from "./persona-resolve.js";

const personas: PersonasConfig = {
  active: "reviewer",
  projects: { "/work/site": "writer", "/work": "reviewer", "/work/off": "default" },
  definitions: {
    reviewer: { instructions: "Review first.", style: "Terse." },
    writer: { instructions: "Plain English." },
  },
};

describe("resolvePersona", () => {
  it("runs without a persona when nothing is configured", () => {
    expect(resolvePersona(undefined, "/anywhere", undefined, "linux")).toEqual({ source: "none" });
    expect(resolvePersona({ projects: {}, definitions: {} }, "/anywhere", undefined, "linux")).toEqual({ source: "none" });
  });

  it("uses the active persona outside any bound folder", () => {
    const got = resolvePersona(personas, "/elsewhere", undefined, "linux");
    expect(got.source).toBe("active");
    expect(got.persona).toEqual({ name: "reviewer", instructions: "Review first.", style: "Terse." });
  });

  it("prefers the closest bound folder over a farther one and over active", () => {
    const got = resolvePersona(personas, "/work/site/src", undefined, "linux");
    expect(got).toMatchObject({ source: "project", projectDir: "/work/site", persona: { name: "writer" } });
    expect(resolvePersona(personas, "/work/other", undefined, "linux").projectDir).toBe("/work");
  });

  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(findProjectBinding({ "/work/site": "writer" }, "/work/site2", "linux")).toBeUndefined();
  });

  it("lets a binding to `default` turn the persona off", () => {
    const got = resolvePersona(personas, "/work/off", undefined, "linux");
    expect(got.source).toBe("project");
    expect(got.persona).toBeUndefined();
    expect(got.unknown).toBeUndefined();
  });

  it("lets the env override win over a binding, `default` included", () => {
    expect(resolvePersona(personas, "/work/site", "reviewer", "linux")).toMatchObject({
      source: "env",
      persona: { name: "reviewer" },
    });
    const off = resolvePersona(personas, "/work/site", "default", "linux");
    expect(off.source).toBe("env");
    expect(off.persona).toBeUndefined();
  });

  it("reports a name with no definition instead of rendering it", () => {
    const got = resolvePersona(personas, "/elsewhere", "ghost", "linux");
    expect(got).toEqual({ source: "env", requested: "ghost", unknown: true });
    // An inherited property is not a definition.
    expect(resolvePersona(personas, "/elsewhere", "constructor", "linux").unknown).toBe(true);
  });

  // `path.relative` on Windows already ignores case, so the Linux half
  // only holds on a POSIX host.
  it.skipIf(process.platform === "win32")("compares folders case-insensitively on macOS and Windows only", () => {
    expect(findProjectBinding({ "/Work/Site": "writer" }, "/work/site", "darwin")?.name).toBe("writer");
    expect(findProjectBinding({ "/Work/Site": "writer" }, "/work/site", "linux")).toBeUndefined();
  });
});
