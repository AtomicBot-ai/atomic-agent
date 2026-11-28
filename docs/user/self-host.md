# Run Atomic Agent on your own server

Status: current
Owner: src/cli/ (serve), Dockerfile, compose.yaml

Run the agent on a VPS or a second computer that stays on. Chats, scheduled tasks and the Telegram, Discord, Slack and other channels keep going while your laptop is closed. It runs on your server, not ours: nothing goes through an Atomic service.

It is the same `atag serve --no-parent-exit` you can start by hand, packaged as a Docker image with `compose.yaml` in the repository root.

## Start it

On the server, in a checkout of this repository:

1. Create `.env` next to `compose.yaml`:

   ```
   ATOMIC_AGENT_API_KEY=<a long random string, 16+ characters>
   ANTHROPIC_API_KEY=<your provider key>   # or OPENAI_API_KEY, OPENROUTER_API_KEY, ...
   ```

   `openssl rand -hex 24` makes a good API key. The server refuses to start on a network address without one.

2. `docker compose up -d`

3. Check it: `curl http://127.0.0.1:8787/health`

The image runs as a normal user, keeps its state (config, `.env`, sessions, memory, skills, channel state) in the `atomic-data` volume and works in the `atomic-work` volume. Updating is `git pull && docker compose up -d --build`; the volumes stay.

## Pick the model and channels

The server reads the same `config.json` and `.env` as the app on your laptop. Any of these works:

- Connect the desktop app to it (Agent › Connect to Another Computer) and change settings there, as on your own machine.
- Run commands inside the container: `docker compose exec agent atag config list --describe model`, `docker compose exec agent atag config set <key> <value>`.
- Copy `config.json` and `.env` from `~/.atomic-agent` on your laptop into the volume (`docker compose cp`), then `docker compose restart`.

A cloud model needs only its key. A local model needs a llama.cpp server the container can reach, for example a GPU box on the same network.

A channel such as Telegram runs in one process at a time. Turn it off on your laptop before the server takes it over, or the server shows it as "already running in another atomic-agent".

## Reach it safely

`compose.yaml` publishes port 8787 on `127.0.0.1` only. Pick one way in:

- **Tailscale** (or another private network): install it on the server and your devices, change the port line to `"8787:8787"`, and use the server's Tailscale address.
- **SSH tunnel**: `ssh -L 8787:127.0.0.1:8787 you@server`, then use `http://127.0.0.1:8787` on your laptop.
- **Reverse proxy with TLS** (Caddy, nginx) in front of `127.0.0.1:8787`.

Do not publish the port to the open internet without TLS: the API key travels in every request.

Then:

- **Desktop app**: Agent › Connect to Another Computer, with the address and the API key.
- **Phone**: run `atag pair --url http://<address>:8787` (in Docker: `docker compose exec agent atag pair --url http://<address>:8787`) and scan the QR code: the panel opens without the key. Or open `http://<address>:8787/panel` and enter the API key. Add it to the home screen: on an iPhone that app keeps its own sign-in, apart from Safari, so tap Connect this app there and type the short code `atag pair` prints under the QR. `atag pair --list` shows paired phones, `atag pair --revoke <id>` signs one out; a phone not used for 30 days is signed out on its own.
- **API clients**: `http://<address>:8787/v1`, bearer token = the API key.

## Without Docker

On any machine with Node 25.7: build the agent, then

```
ATOMIC_AGENT_API_KEY=<key> atag serve --host 0.0.0.0 --no-parent-exit
```

and keep it running with your service manager (systemd, launchd, a Windows service). `atag serve --help` lists every flag.
