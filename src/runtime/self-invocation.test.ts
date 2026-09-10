import { describe, expect, it } from "vitest";

import { selfInvocation } from "./self-invocation.js";

describe("selfInvocation", () => {
  it("re-runs a SEA binary as itself, with no script path", () => {
    expect(
      selfInvocation({
        execPath: "/usr/local/bin/atomic-agent",
        argv: [
          "/usr/local/bin/atomic-agent",
          "/usr/local/bin/atomic-agent",
          "models",
          "pull",
        ],
        isSea: true,
      }),
    ).toEqual({ cmd: "/usr/local/bin/atomic-agent", args: [] });
  });

  it("re-runs a node script through node with the script path", () => {
    expect(
      selfInvocation({
        execPath: "/opt/node/bin/node",
        argv: [
          "/opt/node/bin/node",
          "/repo/dist/cli/index.js",
          "models",
          "pull",
        ],
        isSea: false,
      }),
    ).toEqual({ cmd: "/opt/node/bin/node", args: ["/repo/dist/cli/index.js"] });
  });

  it("keeps loader flags ahead of the script so a tsx dev run stays runnable", () => {
    expect(
      selfInvocation({
        execPath: "/opt/node/bin/node",
        argv: ["/opt/node/bin/node", "/repo/src/cli/index.ts"],
        execArgv: ["--import", "tsx"],
        isSea: false,
      }),
    ).toEqual({
      cmd: "/opt/node/bin/node",
      args: ["--import", "tsx", "/repo/src/cli/index.ts"],
    });
  });

  it("refuses a node run with no script path rather than guessing", () => {
    expect(() =>
      selfInvocation({
        execPath: "/opt/node/bin/node",
        argv: ["/opt/node/bin/node"],
        isSea: false,
      }),
    ).toThrow(/no script path/);
  });
});
