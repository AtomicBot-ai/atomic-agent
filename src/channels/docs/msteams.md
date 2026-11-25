# Microsoft Teams channel setup

Status: current
Owner: src/channels/msteams/

The Teams channel ([msteams-channel](../msteams/msteams-channel.ts), ATO-506) talks to your own Azure Bot. Atomic Agent runs no relay: Microsoft's Bot Framework calls a small endpoint on your machine, and you choose how that endpoint is reachable from the internet. The channel is off by default and only answers the Entra (Azure AD) users you list as owners.

## 1. Register an Azure Bot

1. In the Azure portal create an **Azure Bot** resource. Type of app: **Single Tenant** (recommended, your organisation only) or **Multi Tenant**. Let it create a new Microsoft App ID.
2. Open the bot's **Configuration**: copy the **Microsoft App ID**. Under **Manage Password** create a client secret and copy its value (shown once). For a single-tenant bot also copy the **App Tenant ID**.
3. Under **Channels** add **Microsoft Teams**.
4. Set **Messaging endpoint** to your public tunnel URL plus `/api/messages` (step 3 below), for example `https://agent-yourname.example.com/api/messages`.

## 2. Configure Atomic Agent

Secrets go in `<stateDir>/.env` (normally `~/.atomic-agent/.env`), never in `config.json`:

```
MSTEAMS_APP_ID=00000000-0000-0000-0000-000000000000
MSTEAMS_APP_PASSWORD=your-client-secret
```

Then in `config.json`:

```json
{
  "channels": {
    "msteams": {
      "enabled": true,
      "ownerIds": ["<your Entra object id>"],
      "options": { "port": 3978, "tenantId": "<App Tenant ID, single-tenant only>" }
    }
  }
}
```

`ownerIds` are Entra **object ids** (Azure portal, Microsoft Entra ID, Users, your user, Object ID). An empty list refuses everyone. `port` defaults to 3978; the endpoint binds `127.0.0.1` only. Leave `tenantId` out for a multi-tenant bot.

## 3. Expose the endpoint with your own tunnel

Bot Framework must reach `http://127.0.0.1:3978/api/messages` over public HTTPS. Atomic Agent does not provide a tunnel; use one you control, for example:

- Cloudflare Tunnel: `cloudflared tunnel --url http://127.0.0.1:3978` (a named tunnel keeps the URL stable).
- ngrok: `ngrok http 3978`.
- Microsoft Dev Tunnels: `devtunnel host -p 3978 --allow-anonymous`.

Every request is still checked: the Bot Framework JWT must be signed by a Bot Framework key, issued by `https://api.botframework.com`, addressed to your App ID, unexpired, and its `serviceurl` claim must match the activity. Anything else gets a 401. Replies are only sent to service URLs that arrived in an authenticated request. A quick tunnel URL changes on every restart; update the messaging endpoint when it does.

## 4. Install the bot in Teams

Create a Teams app package (a zip with `manifest.json`, `color.png` 192x192 and `outline.png` 32x32), for example in the Teams Developer Portal (Apps, New app, App features, Bot, "Enter a bot ID" with your App ID; scopes Personal, Team and Group chat). A minimal `manifest.json`:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json",
  "manifestVersion": "1.17",
  "version": "1.0.0",
  "id": "<Microsoft App ID>",
  "developer": { "name": "You", "websiteUrl": "https://atomicagent.io", "privacyUrl": "https://atomicagent.io", "termsOfUseUrl": "https://atomicagent.io" },
  "name": { "short": "Atomic Agent" },
  "description": { "short": "My local Atomic Agent", "full": "Talks to the Atomic Agent running on my computer." },
  "icons": { "color": "color.png", "outline": "outline.png" },
  "accentColor": "#FFFFFF",
  "bots": [{ "botId": "<Microsoft App ID>", "scopes": ["personal", "team", "groupChat"], "supportsFiles": false }],
  "validDomains": []
}
```

Upload it with **Apps, Manage your apps, Upload an app** (your tenant may require an admin to allow custom apps).

## Using it

Chat with the bot directly, or @mention it in a channel or group chat. Each personal chat is one session; each channel thread is its own. Commands: `/help`, `/status`, `/new`, `/model`, `/cancel`. Approvals arrive as a card with Approve and Deny (and "Allow always" when it is offered); only an owner's click counts, and the card is replaced with the decision. Typing `yes <code>` or `no <code>` works too. Replies are split at 4000 characters. Lock `<stateDir>/msteams.lock`, sessions `<stateDir>/msteams-session.json`.

Not yet: files in either direction, proactive messages (task reports, digests), a settings screen in the desktop app and TUI.
