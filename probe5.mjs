import { TelegramChannel } from "./dist/channels/telegram/telegram-channel.js";
import { StructuredLogger } from "./dist/tracing/structured-logger.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "probe5-"));
const runtime = { approvals:{resolve:()=>true}, setApprovalHandlerForSession:()=>()=>undefined,
  createSession:()=>({id:"s1",metadata:{}}), sessionStore:{load:()=>null},
  turnController:{isBusy:()=>false}, runTurn: async()=>({}) };
const logger = new StructuredLogger({ level:"info", sinks: [] });
const channel = new TelegramChannel({
  runtime,
  config: { paths:{stateDir:dir}, telegram:{enabled:true, ownerUserId:71793912, parseMode:"html", progressIndicator:true} },
  token: process.env.BOT2,
  logger,
});
await channel.start();
console.log("pid", process.pid);
setInterval(() => console.log(new Date().toISOString().slice(11,19), "state:", channel.state(), "err:", channel.lastError()), 20000);
setTimeout(() => process.exit(0), 200000);
