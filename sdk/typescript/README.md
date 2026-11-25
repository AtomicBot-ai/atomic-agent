# @atomicagent/sdk (TypeScript)

A thin typed client for Atomic Agent. It starts the agent's NDJSON sidecar as a child process and gives you threads, turns and typed events. No dependencies beyond Node built-ins.

Not published to npm yet: build it from this folder (`npx tsc -p tsconfig.json`) or import `src/` directly.

## Requirements

- Atomic Agent installed from npm (`npm i -g atomic-agent`), which puts the `atomic-agent-sidecar` command on your PATH.
- Or a source checkout: pass `binary: "/path/to/atomic-agent/dist/sidecar/main.js"`. A `.js` path is run with the current Node.

The single-file release binary has no sidecar mode; for that build use the HTTP API (`atomic-agent serve`).

## Quickstart

```ts
import { AtomicAgent } from "@atomicagent/sdk";

const agent = new AtomicAgent({
  // binary: "/path/to/atomic-agent/dist/sidecar/main.js",
  // env: { ATOMIC_AGENT_STATE_DIR: "/tmp/agent-state" },
});

const thread = await agent.startThread({ workingDir: process.cwd() });
const result = await thread.run("List the TODOs in this repo");
console.log(result.finalResponse);

await agent.close();
```

## Streaming

```ts
const { events, result } = thread.runStreamed("Summarize README.md");
for await (const event of events) {
  if (event.type === "assistant_delta") process.stdout.write(event.payload.text);
  if (event.type === "tool_call_started") console.log("\n>", event.payload.tool);
}
const { reason, stepCount } = await result;
```

`events` ends when the turn ends. Events are typed by name (`AgentEvent`); the payload of `event.type === "tool_call_result"` is a `ToolCallResultPayload`, and so on.

## Approvals

The agent asks before shell commands, file writes outside the workspace and similar steps. Answer with `onApprovalRequest`:

```ts
const agent = new AtomicAgent({
  onApprovalRequest: async (req) => {
    console.log(req.tool, req.reason, req.preview);
    return req.tool === "os.shell" ? { approved: true, grant: "session" } : false;
  },
});
```

Return `true` / `false`, or an object with the sidecar's `approval_response` fields (`grant`, `reason`, `answer` for `ask_user` questions). Without a handler every request is denied, so a run never waits forever.

## Cancel, steer, close

```ts
const controller = new AbortController();
const running = thread.run("Long task", { signal: controller.signal, maxSteps: 40 });
controller.abort();            // sends `cancel`; the turn ends with reason "cancelled"

await thread.steer("Also check the tests");  // false when no turn is running
await agent.close();           // `shutdown`, then stops the process
```

After a cancel, start a new thread for further work.

## Things to know

- One process hosts one session. `startThread()` replaces the previous thread of the same `AtomicAgent`; use several `AtomicAgent`s for parallel sessions.
- Turns on one thread run in order; the sidecar queues a second `run()` behind the first.
- `env` is added on top of `process.env`.
- Failed requests reject with `AtomicAgentError` (`code`, `requestType`); a process that fails to start or exits rejects with `SidecarExitedError` (`exitCode`, last `stderr`).

## Protocol types

`src/protocol.ts` mirrors `src/sidecar/sidecar-events.ts` in the agent repo instead of importing it, so this package can install on its own. `protocol-compat.test.ts` fails when the request or event names drift.

## Tests

From the repo root: `npx vitest run sdk/typescript`. The tests drive `test/fake-sidecar.mjs`, a scripted stand-in that speaks the same frames, so they need no model and no build.
