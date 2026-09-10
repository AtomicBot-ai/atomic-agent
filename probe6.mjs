import { createAgentRuntime } from "./dist/runtime/bootstrap.js";
const runtime = await createAgentRuntime({
  workingDir: process.cwd(),
  approvalLevel: 1,
  handlers: {
    onChannelStatus: (s) => console.log("STATUS", JSON.stringify(s)),
    logSinks: [{ write: (e) => console.log("LOG", e.level, e.message, JSON.stringify(e.context ?? {}).slice(0, 160)) }],
  },
});
console.log("pid", process.pid, "telegram:", runtime.telegramChannel?.state(), "swarm units:", runtime.swarm?.list().length);
setInterval(() => {
  console.log("tick telegram:", runtime.telegramChannel?.state(), runtime.telegramChannel?.lastError(),
    "| units:", runtime.swarm?.views().map(v => `${v.label}=${v.state}`).join(","));
}, 15000);
setTimeout(async () => { await runtime.shutdown(); process.exit(0); }, 120000);
