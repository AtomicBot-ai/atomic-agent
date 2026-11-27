/**
 * `atag connect linear` (ATO-2464): set up the Linear channel in one go.
 *
 * Asks how Linear should reach the agent (polling, the default, needs no
 * public address; a webhook is instant but needs a tunnel; a Linear app
 * adds agent sessions), takes the key without echoing it, checks it with
 * Linear, picks the owner, and saves: secrets through the agent's
 * credential store (`.env` or the OS keychain), the rest in
 * `channels.linear`. Same idea as Cline's `cline connect` and OpenClaw's
 * channel setup: one command instead of hand-editing two files.
 */

import {
  LINEAR_API_KEY_KEY,
  LINEAR_DEFAULT_PORT,
  LINEAR_OAUTH_CLIENT_SECRET_KEY,
  LINEAR_OAUTH_REDIRECT_URI,
  LINEAR_OAUTH_REFRESH_TOKEN_KEY,
  LINEAR_USER_ID_RE,
  LINEAR_WEBHOOK_PATH,
  LINEAR_WEBHOOK_SECRET_KEY,
  LinearApi,
  LinearApiError,
  buildLinearAuthorizeUrl,
  disableLinearChannel,
  exchangeLinearCode,
  findLinearUserByEmail,
  newOAuthState,
  readLinearMentions,
  saveLinearSecret,
  waitForLinearOAuthCode,
  writeLinearChannelConfig,
  type LinearChannelSettings,
  type LinearTokens,
} from "../channels/linear/index.js";
import type { WizardIo } from "./connect-prompts.js";

export const CONNECT_LINEAR_HELP = [
  "Usage: atag connect linear [--poll | --webhook | --app] [--owner <linear-user-id>] [--mention <handle>]",
  "       atag connect linear --off",
  "",
  "Connect Atomic Agent to Linear: mention @agent in an issue comment and it answers there.",
  "",
  "  --poll      Check Linear every minute. No public address or tunnel needed (default)",
  "  --webhook   Linear calls the agent at once; needs a tunnel such as cloudflared",
  "  --app       Install the agent as a Linear app: people can mention it or delegate issues",
  "              to it, with live progress in Linear (agent sessions; needs a tunnel)",
  "  --owner     The Linear user id the agent answers (default: the key's own user)",
  "  --mention   The handle that addresses the agent in comments (default: agent)",
  "  --off       Turn the channel off; saved keys stay",
  "",
  "Keys are never taken as arguments. They are saved where the agent keeps keys (.env or the OS keychain).",
].join("\n");

type Mode = "poll" | "webhook" | "app";

export interface ConnectLinearDeps {
  io: WizardIo;
  stateDir: string;
  configPath: string;
  openUrl?: (url: string) => Promise<{ ok: boolean }>;
  makeApi?: (key: string) => Pick<LinearApi, "viewer" | "query">;
  waitForCode?: (state: string) => Promise<string>;
  exchange?: (opts: { clientId: string; clientSecret: string; code: string }) => Promise<LinearTokens>;
  saveSecret?: (stateDir: string, name: string, value: string | null) => unknown;
  writeConfig?: (configPath: string, settings: LinearChannelSettings) => void;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function connectLinear(args: string[], deps: ConnectLinearDeps): Promise<number> {
  const { io } = deps;
  if (args.includes("-h") || args.includes("--help")) {
    io.write(`${CONNECT_LINEAR_HELP}\n`);
    return 0;
  }
  if (args.includes("--off")) {
    const changed = disableLinearChannel(deps.configPath);
    io.write(changed ? "Linear channel turned off. Restart the agent to apply it.\n" : "The Linear channel was not set up.\n");
    return 0;
  }
  const owner = flag(args, "--owner");
  if (owner !== undefined && !LINEAR_USER_ID_RE.test(owner)) {
    io.write("--owner must be a Linear user id (a uuid such as 2f1c...-...).\n");
    return 2;
  }
  const mentionFlag = flag(args, "--mention");
  const mode = await pickMode(args, io);
  if (mode === null) return 2;

  let key: string;
  let webhookSecret: string | null = null;
  const extraSecrets: Array<[string, string]> = [];
  let oauthClientId: string | undefined;
  if (mode === "app") {
    const app = await installApp(deps);
    if (app === null) return 1;
    ({ key, webhookSecret, oauthClientId } = app);
    extraSecrets.push(...app.secrets);
  } else {
    io.write("\nCreate a personal API key in Linear: Settings, Account, Security & access, Personal API keys.\n");
    io.write("Tip: a separate Linear member for the agent keeps its comments apart from yours.\n");
    key = await io.askSecret("Linear API key (lin_api_...): ");
    if (mode === "webhook") {
      io.write(`\nIn Linear: Settings, API, Webhooks, New webhook. URL: <your tunnel>${LINEAR_WEBHOOK_PATH}, resource types Comments and Issues.\n`);
      webhookSecret = await io.askSecret("Webhook signing secret: ");
      if (!webhookSecret) {
        io.write("A webhook needs its signing secret. Run again, or use --poll.\n");
        return 1;
      }
    }
  }
  if (!key) {
    io.write("No key entered; nothing was saved.\n");
    return 1;
  }

  const api = (deps.makeApi ?? ((k: string) => new LinearApi({ apiKey: k })))(key);
  let viewer: { id: string; name: string };
  try {
    viewer = await api.viewer();
  } catch (err) {
    io.write(
      err instanceof LinearApiError && err.code === "auth"
        ? "Linear refused that key. Check it and run the command again. Nothing was saved.\n"
        : "Could not reach Linear to check the key. Check the connection and try again. Nothing was saved.\n",
    );
    return 1;
  }
  io.write(`Connected to Linear as ${viewer.name || "the key's user"}.\n`);

  const ownerIds = owner ? [owner] : await pickOwners(mode, viewer, api, io);
  if (ownerIds === null) return 1;
  let mention: string | undefined;
  if (mode !== "app") {
    const typed = mentionFlag ?? (await io.ask("Handle to mention the agent with [agent]: "));
    mention = readLinearMentions({ mention: typed || "agent" }).join(",");
  }

  const save = deps.saveSecret ?? saveLinearSecret;
  save(deps.stateDir, LINEAR_API_KEY_KEY, key);
  if (webhookSecret) save(deps.stateDir, LINEAR_WEBHOOK_SECRET_KEY, webhookSecret);
  for (const [name, value] of extraSecrets) save(deps.stateDir, name, value);
  (deps.writeConfig ?? writeLinearChannelConfig)(deps.configPath, {
    enabled: true,
    ownerIds,
    mode: mode === "poll" ? "poll" : "webhook",
    ...(mention ? { mention } : {}),
    ...(oauthClientId ? { oauthClientId } : {}),
  });
  io.write(nextSteps(mode, mention));
  return 0;
}

async function pickMode(args: string[], io: WizardIo): Promise<Mode | null> {
  const given = (["poll", "webhook", "app"] as const).filter((m) => args.includes(`--${m}`));
  if (given.length > 1) {
    io.write("Pick one of --poll, --webhook, --app.\n");
    return null;
  }
  if (given[0]) return given[0];
  io.write(
    [
      "How should Linear reach the agent?",
      "  1) Polling: checks Linear every minute, no public address needed (recommended)",
      "  2) Webhook: answers at once, needs a tunnel such as cloudflared",
      "  3) Linear app: the agent becomes a workspace member you can delegate issues to (needs a tunnel)",
      "",
    ].join("\n"),
  );
  const answer = (await io.ask("Choose 1, 2 or 3 [1]: ")) || "1";
  const picked = ({ "1": "poll", "2": "webhook", "3": "app" } as const)[answer as "1" | "2" | "3"];
  if (!picked) io.write("Please answer 1, 2 or 3.\n");
  return picked ?? null;
}

async function installApp(
  deps: ConnectLinearDeps,
): Promise<{ key: string; webhookSecret: string | null; oauthClientId: string; secrets: Array<[string, string]> } | null> {
  const { io } = deps;
  io.write(
    [
      "",
      "In Linear: Settings, API, OAuth applications, New application.",
      `  Callback URL: ${LINEAR_OAUTH_REDIRECT_URI}`,
      `  Webhooks: on, URL <your tunnel>${LINEAR_WEBHOOK_PATH}, with Agent session events, Comments and Issues.`,
      "Then copy the client ID, the client secret and the webhook signing secret.",
      "",
    ].join("\n"),
  );
  const clientId = await io.ask("Client ID: ");
  const clientSecret = await io.askSecret("Client secret: ");
  const webhookSecret = await io.askSecret("Webhook signing secret: ");
  if (!clientId || !clientSecret || !webhookSecret) {
    io.write("All three are needed for a Linear app. Nothing was saved.\n");
    return null;
  }
  const state = newOAuthState();
  const url = buildLinearAuthorizeUrl(clientId, state);
  const opened = deps.openUrl ? await deps.openUrl(url) : { ok: false };
  io.write(`${opened.ok ? "Opened Linear in your browser." : "Open this link in your browser:"}\n  ${url}\nApprove the install for your workspace, then come back here.\n`);
  let tokens: LinearTokens;
  try {
    const code = await (deps.waitForCode ?? ((s: string) => waitForLinearOAuthCode(s)))(state);
    tokens = await (deps.exchange ?? ((o) => exchangeLinearCode(o)))({ clientId, clientSecret, code });
  } catch (err) {
    io.write(`Linear did not finish the install: ${err instanceof Error ? err.message : String(err)}. Nothing was saved.\n`);
    return null;
  }
  const secrets: Array<[string, string]> = [[LINEAR_OAUTH_CLIENT_SECRET_KEY, clientSecret]];
  if (tokens.refreshToken) secrets.push([LINEAR_OAUTH_REFRESH_TOKEN_KEY, tokens.refreshToken]);
  return { key: tokens.accessToken, webhookSecret, oauthClientId: clientId, secrets };
}

async function pickOwners(
  mode: Mode,
  viewer: { id: string; name: string },
  api: Pick<LinearApi, "query">,
  io: WizardIo,
): Promise<string[] | null> {
  if (mode !== "app") {
    const yes = (await io.ask(`Answer only ${viewer.name || "the key's user"} (the key's owner)? [Y/n]: `)).toLowerCase();
    if (yes === "" || yes === "y" || yes === "yes") return [viewer.id];
  }
  const email = await io.ask("Your Linear email (the agent answers only you): ");
  try {
    const user = email ? await findLinearUserByEmail(api, email) : null;
    if (user) {
      io.write(`Owner: ${user.name || email}.\n`);
      return [user.id];
    }
  } catch {
    // fall through to the same message
  }
  io.write("No Linear user with that email in this workspace. Run again with --owner <id>. Nothing was saved.\n");
  return null;
}

function nextSteps(mode: Mode, mention: string | undefined): string {
  const handle = `@${(mention ?? "agent").split(",")[0]}`;
  const lines = ["", "Saved. Restart the agent (the TUI, `atag serve` or the desktop app) to start the Linear channel."];
  if (mode !== "poll") {
    lines.push(
      "Linear has to reach this computer. Start a tunnel, for example:",
      `  cloudflared tunnel --url http://127.0.0.1:${LINEAR_DEFAULT_PORT}`,
      `and put its address plus ${LINEAR_WEBHOOK_PATH} in the Linear webhook.`,
    );
  }
  lines.push(
    mode === "app"
      ? "Then mention the app in an issue, or delegate the issue to it."
      : `Then, in a Linear issue, comment: ${handle} summarize this issue`,
    "",
  );
  return lines.join("\n");
}
