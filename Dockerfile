# Atomic Agent as an always-on server (ATO-595).
#
# Runs `atag serve --no-parent-exit` on your own VPS or second computer, so
# chats, scheduled tasks and the Telegram / Discord / Slack channels keep
# going while your laptop is closed. The desktop app, the phone panel
# (/panel) and the API connect to it with the API key.
#
#   docker compose up -d          (see compose.yaml and docs/user/self-host.md)
#
# Nothing secret is baked into the image: the API key and provider keys come
# from the environment or from the .env in the state volume.

ARG NODE_VERSION=25.7.0

FROM node:${NODE_VERSION}-bookworm-slim AS build
# better-sqlite3 compiles from source when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY starter-skills ./starter-skills
COPY grammars ./grammars
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim
# git, ripgrep (the grep tool finds `rg` on PATH) and ca-certificates for the
# agent's own tools; tini reaps child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/grammars ./grammars
COPY --from=build /app/assets ./assets
RUN ln -s /app/dist/cli/index.js /usr/local/bin/atag \
 && chmod +x /app/dist/cli/index.js \
 && mkdir -p /data /work \
 && chown node:node /data /work

ENV NODE_ENV=production \
    ATOMIC_AGENT_STATE_DIR=/data \
    ATOMIC_AGENT_SERVE_NO_PARENT_EXIT=1 \
    ATOMIC_AGENT_UPDATE_CHECK_ON_STARTUP=false
USER node
VOLUME ["/data", "/work"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli/index.js"]
# A host other than loopback needs ATOMIC_AGENT_API_KEY (16+ characters):
# serve refuses to start without one.
CMD ["serve", "--host", "0.0.0.0", "--port", "8787", "--cwd", "/work", "--no-parent-exit"]
