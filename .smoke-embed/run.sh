#!/bin/bash
# Isolated live smoke for EmbeddingGemma 2 via Atomic Core (separate state dir, never the user's profile).
set -u
export ATOMIC_AGENT_STATE_DIR="$HOME/checks/tmp/embed-smoke-state"
rm -rf "$ATOMIC_AGENT_STATE_DIR"; mkdir -p "$ATOMIC_AGENT_STATE_DIR"
A="node dist/cli/index.js"
step() { echo; echo "=== $*"; }
fail=0
step "engine"; $A models engine || true
step "set managed mode + memory embeddings on (test profile only)"
node -e 'const f=process.env.ATOMIC_AGENT_STATE_DIR+"/config.json";const fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.localModels={...(c.localModels||{}),mode:"managed",embeddings:{...((c.localModels||{}).embeddings||{}),enabled:true}};c.memory={...(c.memory||{}),embeddings:{...((c.memory||{}).embeddings||{}),enabled:true}};fs.writeFileSync(f,JSON.stringify(c,null,2));console.log(JSON.stringify({mode:c.localModels.mode,emb:c.localModels.embeddings,mem:c.memory.embeddings}))'
step "list-embeddings (before)"; $A models list-embeddings || fail=1
step "pull-embedding"; $A models pull-embedding embeddinggemma-2 || fail=1
step "use-embedding"; $A models use-embedding embeddinggemma-2 || fail=1
step "start-embedding (installs Core + upstream llama.cpp if needed)"; time $A models start-embedding || fail=1
step "list-embeddings (running)"; $A models list-embeddings || fail=1
step "start-embedding again (already running)"; $A models start-embedding || fail=1
step "status"; $A models status || true
step "live client"; node .smoke-embed/client.mjs || fail=1
step "memory: backfill + recall by meaning (RU note, EN query) + notes tool"; node .smoke-embed/memory.mjs || fail=1
step "memory reindex CLI"; $A memory reindex --json || fail=1
step "stop-embedding"; $A models stop-embedding || fail=1
step "list-embeddings (stopped)"; $A models list-embeddings || fail=1
step "models stop"; $A models stop || true
sleep 5
step "leftover processes for this state dir"; ps -axo pid,command | grep -F "$ATOMIC_AGENT_STATE_DIR" | grep -v grep && { echo "FAIL leftovers"; fail=1; } || echo "none"
step "state dir"; ls "$ATOMIC_AGENT_STATE_DIR"; find "$ATOMIC_AGENT_STATE_DIR" -name 'embedding-module.json' -exec cat {} \;
echo; [ $fail = 0 ] && echo "SMOKE PASS" || echo "SMOKE FAIL"
exit $fail
