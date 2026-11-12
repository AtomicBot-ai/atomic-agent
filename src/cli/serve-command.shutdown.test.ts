import { afterEach, describe, expect, it, vi } from "vitest";

import { serveCommand } from "./serve-command.js";

// ATO-1419: how serve ends decides how its task runs are left. The memory
// guard ending serve is a crash (the runs count against maxResumes); a
// parent that went away (or a signal) is a clean stop. This drives
// `serveCommand` itself, with stand-ins only at its edges (the runtime,
// the HTTP server, the serve record, the guards), so the one line that
// ties the guard's exit to `shutdown({crashed: true})` is what is tested.

const edges = vi.hoisted(() => ({
  shutdown: [] as unknown[],
  exhaust: null as (() => void) | null,
  orphan: null as (() => void) | null,
}));

vi.mock("../runtime/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/bootstrap.js")>();
  return {
    ...actual,
    createAgentRuntime: async () => ({
      turnController: { busySessionIds: () => [] },
      approvals: { isPending: () => false },
      shutdown: async (options?: unknown) => {
        edges.shutdown.push(options);
      },
    }),
  };
});

vi.mock("../http/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http/index.js")>();
  return {
    ...actual,
    buildRouteTable: () => [],
    createHttpServer: async () => ({ host: "127.0.0.1", port: 1, close: async () => {} }),
  };
});

vi.mock("./serve-reaper.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serve-reaper.js")>();
  return { ...actual, registerServe: () => () => {}, reapOrphanedServes: async () => [] };
});

vi.mock("./serve-memory-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serve-memory-guard.js")>();
  return {
    ...actual,
    memoryGuardDisabled: () => false,
    startServeMemoryGuard: () => ({
      exhausted: new Promise<void>((resolve) => {
        edges.exhaust = resolve;
      }),
      stop: () => {},
    }),
  };
});

vi.mock("./serve-orphan-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serve-orphan-guard.js")>();
  return {
    ...actual,
    watchForOrphaning: (opts: { onOrphaned: () => void }) => {
      edges.orphan = opts.onOrphaned;
      return () => {};
    },
  };
});

/** Start serve, end it the way `end` says once it is up, and return its exit code. */
async function serveEndedBy(end: "memory" | "orphaned"): Promise<number> {
  edges.shutdown = [];
  edges.exhaust = null;
  edges.orphan = null;
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const running = serveCommand(["--parent-pid", "4242"]);
  await vi.waitFor(() => {
    expect(edges.exhaust).not.toBeNull();
    expect(edges.orphan).not.toBeNull();
  });
  if (end === "memory") edges.exhaust?.();
  else edges.orphan?.();
  return running;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serve's own end decides how its task runs are left (ATO-1419)", () => {
  it("the memory guard's exit shuts the runtime down as crashed, with exit code 86", async () => {
    expect(await serveEndedBy("memory")).toBe(86);
    expect(edges.shutdown).toEqual([{ crashed: true }]);
  });

  it("a parent that went away is a clean stop: not crashed, exit code 0", async () => {
    expect(await serveEndedBy("orphaned")).toBe(0);
    expect(edges.shutdown).toEqual([undefined]);
  });
});
