import { getConfig } from "../config/index.js";
import {
  disablePushNotifications,
  enablePushNotifications,
  isPushReady,
  pushPrivacyNote,
  pushSubscribeUrl,
  sendPush,
  type PushSetupResult,
} from "../notifications/index.js";

/**
 * ATO-1129 — `atomic-agent push`: phone notifications through ntfy, no
 * bot to set up. `on` mints a random topic (kept on later `on`s), the
 * operator subscribes to it in the ntfy app, and finished long turns,
 * failed turns, waiting approvals, `--notify push` tasks and downloads
 * ping the phone.
 */
const HELP = [
  "Usage: atomic-agent push <command>",
  "",
  "Phone notifications through ntfy (https://ntfy.sh or your own server).",
  "Install the ntfy app on the phone and subscribe to the topic `on` prints.",
  "",
  "Commands:",
  "  on [--server <url>] [--new-topic]  Turn push on; mints a random topic the first time",
  "  off                                Turn push off (the topic is kept for next time)",
  "  status                             Show whether push is on and where it goes",
  "  test                               Send a test ping now",
  "",
  "Pings: a turn that ran long (tui.notify.minDurationMs) or failed, an approval left",
  "waiting, and `task create` / `overnight` / `models pull --background` with",
  "--notify push. Each carries a title and the first 200 characters of the answer,",
  "never tool output. A protected topic takes an access token: put NTFY_TOKEN=<token>",
  "in the .env of the data folder (`atomic-agent data path`).",
].join("\n");

export interface PushCommandDeps {
  write?: (text: string) => void;
  fetchImpl?: typeof fetch;
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const joined = args.find((a) => a.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function pushCommand(
  args: string[],
  deps: PushCommandDeps = {},
): Promise<number> {
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h") {
    write(`${HELP}\n`);
    return sub ? 0 : 2;
  }
  if (sub === "on") {
    const server = readFlag(rest, "--server");
    if (rest.includes("--server") && (server === undefined || server.startsWith("--"))) {
      process.stderr.write("--server needs a URL, e.g. --server https://ntfy.example.com\n");
      return 2;
    }
    let setup: PushSetupResult;
    try {
      setup = enablePushNotifications({
        ...(server !== undefined ? { server } : {}),
        newTopic: rest.includes("--new-topic"),
      });
    } catch (err) {
      process.stderr.write(`push: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    write(
      [
        `push on${setup.newTopic ? " with a new topic" : ""}`,
        `  subscribe in the ntfy app: ${setup.subscribeUrl}`,
        `  ${pushPrivacyNote(setup.push)}`,
        "  send a test ping: atomic-agent push test",
        "",
      ].join("\n"),
    );
    return 0;
  }
  if (sub === "off") {
    disablePushNotifications();
    write("push off\n");
    return 0;
  }
  const push = getConfig().notifications.push;
  if (sub === "status") {
    const url = pushSubscribeUrl(push);
    write(
      isPushReady(push)
        ? `push on → ${url}\n`
        : `push off${url ? ` (topic kept: ${url})` : ""} · turn it on with: atomic-agent push on\n`,
    );
    return 0;
  }
  if (sub === "test") {
    const result = await sendPush({
      push,
      message: {
        title: "Atomic Agent: test ping",
        body: "Phone push works. Long turns, approvals and --notify push tasks will ping here.",
        tags: ["bell"],
      },
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    if (result.outcome === "sent") {
      write("test ping sent\n");
      return 0;
    }
    process.stderr.write(`push: not sent — ${result.reason}\n`);
    return 1;
  }
  process.stderr.write(`unknown push command: ${sub}\n${HELP}\n`);
  return 2;
}
