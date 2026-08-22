# Hosted test llama-server (Vercel)

A public stub of a **stock llama-server** for end-to-end testing of the External
llama.cpp connector — happy path AND the failure shapes that used to be silent —
from any machine, no local server needed.

Base URL: **https://llama-stub-vercel.vercel.app**
Source: `~/claudecode1/llama-stub-vercel` (one catch-all Vercel function,
`api/stub.mjs`, ported from the proven local stub `stub-llama.mjs`).

## Why path prefixes

Failure shapes are PATH-PREFIX modes — one deployment, four base URLs. Query
strings can never select a mode because the client strips them from the base on
every request (`llamaEndpointUrl` clears `parsed.search`), and headers are fixed.
No prefix ends in `/v1`: the client drops a trailing `/v1` from the base.

The stub always answers `stream:true` in SSE framing (`data:` events). A
plain-JSON answer would parse to a silently empty turn — `runWithFallback`
always calls `completeStream`. Vercel may buffer the whole SSE body into one
flush; the client's parser does not care about chunk boundaries.

## The four shapes

Paste each URL into **LLM tab › External › Enter** (edit the base URL, Enter
saves after a `/health` probe):

| Base URL | Imitates | Expected in the app |
| --- | --- | --- |
| `https://llama-stub-vercel.vercel.app` | stock llama-server | saved; row `[healthy]`; status bar names `qwen3-30b-a3b-q4_k_m.gguf`; a chat turn answers "stub says hi" over SSE |
| `https://llama-stub-vercel.vercel.app/llama` | same server behind a reverse-proxy path prefix | saved with the path preserved (`/llama/health` probed, not origin `/health`); chat turn works |
| `https://llama-stub-vercel.vercel.app/auth` | `llama-server --api-key` (llama.cpp's real exemptions: `/health`, `/models`, `/v1/models`, `/api/tags` stay public) | refused at save time: "http 401 — the server requires an API key (--api-key). Set ATOMIC_AGENT_LLAMA_API_KEY in the state dir's .env and retry." |
| `https://llama-stub-vercel.vercel.app/openai` | OpenAI-compatible-only runner (LM Studio / Ollama / vLLM: `/v1/*` only, no `/health`) | refused with the redirect: "answers like an OpenAI-compatible server, not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › openai-compatible…" |

The `/auth` key is `sk-stub-key` (`STUB_API_KEY` env on the Vercel project); set
`ATOMIC_AGENT_LLAMA_API_KEY=sk-stub-key` to test the accepted-key path.

## Curl smoke

```sh
B=https://llama-stub-vercel.vercel.app
curl $B/health                    # {"status":"ok"}
curl $B/props                     # stock body, model_path .../qwen3-30b-a3b-q4_k_m.gguf
curl -X POST $B/completion -H 'content-type: application/json' \
     -d '{"stream":true,"prompt":"x"}'          # SSE: data: {...}
curl $B/llama/health              # 200
curl $B/auth/health               # 200 (exempt)
curl $B/auth/props                # 401 Invalid API Key
curl -H 'authorization: Bearer sk-stub-key' $B/auth/props   # 200
curl $B/openai/v1/models          # 200, data[]
curl $B/openai/health             # 404
```

Requests are logged (`method path auth`) — visible via
`npx vercel logs llama-stub-vercel.vercel.app` or the Vercel dashboard.

Note: the canonical production URL above is public; hash deployment URLs
(`llama-stub-vercel-*-….vercel.app`) sit behind Vercel's default deployment
protection — always use the canonical URL.
