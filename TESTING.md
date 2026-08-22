# atomic-agent redesign build — test plan

Build = v0.3.7 main + PR #221 + the 8-PR onboarding stack (#220–#228) + 15 new slices.
Every item below names the exact expectation; report PASS/FAIL per item, with a screenshot
or frame excerpt for anything that fails, plus anything odd you notice beyond the list.

## Setup

Fresh first run (delete the state dir to see onboarding again):

```
rm -rf /tmp/atomic-test-state
cd ~/claudecode1/atomic-agent-onboarding && PATH=~/.local/node25/bin:$PATH \
  ATOMIC_AGENT_STATE_DIR=/tmp/atomic-test-state node dist/cli/index.js tui
```

Terminal at 100×30 or larger for the first pass; smaller sizes are their own section.

## 1 · Intro splash

- [ ] Starfield fills the screen: stars in 4 glyphs (`·` `✧` `✦` `✛`) and 4 brightnesses
      (dim blue → white), clustered like sky, not evenly sprinkled
- [ ] The mark is clean inside its clear space — no star touches it or the wordmark
- [ ] Tagline "Local AI-First Agent" types itself in (~1s); cursor `▌` while typing
- [ ] ANY key finishes the reveal; a second one advances to setup
- [ ] Mouse click counts too: click once (reveal finishes), click again (advances)
- [ ] Mouse wheel also counts as input
- [ ] Ctrl+C on the splash quits the app (twice if armed-quit asks)
- [ ] Resize the window while on the splash: layout re-fits live, footer stays on the last row

## 2 · Setup screens, general

- [ ] Every setup screen's content block is centred horizontally AND vertically
- [ ] Rows inside the block stay left-aligned (a block, not ragged centred lines)
- [ ] Hint strip is always the last terminal row
- [ ] Below 100×30 a footer note advises widening — but nothing ever blocks

## 3 · Small terminals

- [ ] ~86×26: reduced tier — mark + wordmark, fewer/no stars, advisory in footer
- [ ] ~60×11: the xs mark (`▗█▄░` / `▀█▘░`) is drawn — NOT a missing icon
- [ ] Any key still advances at every size

## 4 · Choose backend

- [ ] Three options with cost copy (Private/free per token · needs an API key · nothing downloaded)
- [ ] 1/2/3 shortcuts, j/k, arrows, Enter, Esc=skip all work

## 5 · Local models

- [ ] Screen is titled "Recommended models"
- [ ] One row has ★ recommended, sized to this machine's RAM, download ≤ 8 GB
- [ ] Models too big for this machine are dimmed/warned, not hidden
- [ ] "Add a model from Hugging Face…" row exists
- [ ] HF input accepts `owner/repo` or a full URL; junk input shows a readable error on the
      same screen; a repo with no GGUF is refused with a reason
- [ ] Starting a download shows: two bars (runtime, weights), %, MB, speed, ETA
- [ ] ATOMS: slow-floating atoms in the free space below the bars — appearing, disappearing,
      bouncing off edges; on (rare) collision they flash toxic green; slow like a TV bouncer,
      not busy
- [ ] Atoms never draw over the bars/text and stop if the download fails
- [ ] The "press c — set up a cloud model in the meantime" block is visible during a download
- [ ] Pressing `c` opens the cloud wizard; download keeps running

## 6 · Wait or jump (after `c` + wizard finished, download still running)

- [ ] REAL progress bar on this screen (not just a text %)
- [ ] NO "Wait here until it finishes" row
- [ ] "Add another cloud provider" row exists and re-opens the wizard, returning here after
- [ ] One skip row leads to the agent; download continues, chip in the top bar
- [ ] If the download already finished: screen says the local model is ready (no fake 0% bar);
      if it failed: says so and offers Retry

## 7 · Cloud wizard

- [ ] Blue is bright/readable on titles and the selected row (not the old dark navy)
- [ ] Provider list: typing filters (e.g. "open" → OpenRouter/OpenAI rows), counter shows
      filtered/total, empty query state says "no matches", Esc/Enter behave
- [ ] Model list (OpenRouter, 345 rows): same filter; typed query text is bright
- [ ] At 24 terminal rows the footer hint is still visible with the search line present

## 8 · Propose-the-other-backend gating

- [ ] Configure CLOUD only, never open the local screen → after the wizard, the "set up local
      models too?" screen appears
- [ ] Fresh state, OPEN the local models screen, Esc back, then configure cloud → the propose
      screen must NOT appear
- [ ] It is never shown twice (recorded in config)

## 9 · Home screen (after setup or skip)

- [ ] Meta row under the composer reads: backend · provider · model (provider and model
      SWAPPED vs the old order), in a brighter font
- [ ] All three are buttons: mouse click AND keyboard (advertised key) open them
- [ ] Backend switch: three options — cloud / local / custom — switching actually works
- [ ] Provider switch: lists configured providers + "Add a new provider" (opens the wizard)
- [ ] Model switch: full catalog with typing filter and a (n/total) counter

## 10 · Composer

- [ ] Add lines (alt+enter, or shift+enter on kitty-protocol terminals — hint strip states
      which): the input grows UPWARD over the content; background rows DO NOT move
- [ ] Delete the lines: the original screen returns exactly
- [ ] With a tall draft, ctrl+p menu is fully visible (composer collapses while a menu/modal
      is open, re-expands after)
- [ ] Shift+arrows select text (all four directions); plain arrow collapses the selection
- [ ] Ctrl+C with selection copies to the SYSTEM clipboard (paste it somewhere to check);
      without selection Ctrl+C keeps its abort/quit meaning
- [ ] Ctrl+X cuts (clipboard has it, text gone, cursor sane)

## 11 · Controls while the agent thinks

Send a long prompt first (any model; a failing turn is fine — controls matter, not the answer):

- [ ] While "thinking": ctrl+p opens the menu; session picker opens; nothing is frozen
- [ ] New session mid-turn works; a notice says the old turn continues in background
- [ ] The old session's row stays in the rail; switching back shows YOUR PROMPT and progress
      (not an empty pane), spinner still live if running
- [ ] Esc in the NEW session does not abort the detached turn
- [ ] Enter still steers the running turn when you are IN its session (that behaviour is
      unchanged on purpose)

## 12 · External llama.cpp (if you have a llama-server)

- [ ] Plain http://host:port — connects, model name shown
- [ ] Save verdicts (probing…, errors) appear ON the External pane, not on a hidden tab
- [ ] Behind a reverse-proxy path (http://host/llama) — now works (path preserved)
- [ ] Server with --api-key: save is refused with a message naming
      ATOMIC_AGENT_LLAMA_API_KEY; set it in the state dir's .env → connects
- [ ] Pointing it at an OpenAI-only server tells you to add it as a cloud provider instead

## 13 · Regression spot-checks

- [ ] Second launch after finishing/skipping setup: onboarding does NOT reappear
- [ ] Esc-skip on the choose screen lands in the agent and is remembered
- [ ] Top-bar download chip appears during a pull from anywhere in the app; sheds detail on
      narrow terminals instead of wrapping the bar
- [ ] `● cloud/local` status remains legible (glyph + word, not colour alone)
- [ ] Nothing overlaps or pushes the status bar/hint strip at 80×24

## Round 3

Nine items on top of the round-2 build. Same setup as above; a fresh state dir
re-runs onboarding where an item needs it.

### R3.1 · Mouse everywhere in onboarding

- [ ] Choose screen: first click on an option selects it, second click activates —
      same as Enter, no separate click behaviour
- [ ] Same select/activate pattern on: local model picks (incl. the pinned
      "Add a model from Hugging Face…" row), the HF file list, the propose-second
      screen, the wait-or-jump rows, and the cloud wizard's pick lists
- [ ] Cloud wizard rows are clickable both inside onboarding AND in the
      Providers/LLM panels (clicks act on the wizard the frame drew, not a stale one)
- [ ] URL / HF reference editors: click-to-caret works
- [ ] Download screen: clicking the "press c" offer block opens the cloud wizard
      (same as pressing c)
- [ ] Mouse wheel on any setup list walks the cursor; the wheel never scrolls the
      invisible chat transcript behind the flow
- [ ] HF reference screen has a `[ clear ]` control below the input (click or ctrl+l)
      that empties the field

### R3.2 · Centred download screen + ambient atoms

- [ ] The download step's text block (headline, bars, offer) is centred like every
      other setup screen — it no longer hugs the full width
- [ ] The atom field is ambient: it spans the full terminal width BELOW the centred
      block, in the free space, never inside/over the text
- [ ] Atoms stop when the pull fails or finishes; the "press c" offer stays clickable
      inside the centred block

### R3.3 · Local meta row — chosen-model switch

- [ ] In local (managed) mode the composer's second control shows the CHOSEN model id
      (the catalog id you picked, not the GGUF file name from /props)
- [ ] Opening it lists DOWNLOADED models only, plus a "Download more models…" row
      that deep-links to Manage > LLM > Local
- [ ] On a fresh boot with models on disk the switch lists them (a one-shot refresh
      fires on open; a "loading…" row may flash, never a false "nothing downloaded")
- [ ] Picking "local" as backend right after onboarding labels the backend control
      "local", not "custom" — including on the home screen before the Models tab was
      ever opened
- [ ] The <-/-> strip walk skips the provider switch in local mode (not drawn there);
      cloud mode is unchanged

### R3.4 · Local meta row — daemon status + RAM

- [ ] Third control reads status word + RAM, e.g. "healthy · 4.4 GB"
- [ ] starting = daemon starting/loading or health probing; healthy = health probe OK;
      down = unreachable/error; unknown renders nothing
- [ ] No RAM segment when there is no managed daemon pid (external mode, daemon down)
- [ ] Clicking the control opens the local models pane — it never switches or
      downloads anything

### R3.5 · Download chip label cap

- [ ] A custom HF model with a very long id (80+ chars) shows an ellipsised chip label
      (≤ 30 columns) — the status bar stays one row
- [ ] On narrow terminals the chip sheds to the percent-only form instead of
      overflowing; actions still target the full untruncated id

### R3.6 · Not-downloaded turn gate

- [ ] Managed mode, active local model NOT on disk: submitting a turn is refused
      up front — "local model X is not downloaded — open Models (/local) …
      (message returned to the editor)" — no transport-retry burn, no bare
      "fetch failed"
- [ ] While a pull is in flight the refusal shows LIVE progress
      ("downloading now — 53% · 2.1 GB / 4.2 GB")
- [ ] The gate also fires for a llama-server provider saved under a custom id
      (detection is by provider KIND, not the literal `local-llama` id)
- [ ] With a fallback chain of >1 link the turn RUNS (one-line notice only) and
      fails over
- [ ] External mode and cloud providers never gate
- [ ] A blocked submit returns the text to the editor and does NOT create a
      /history entry (a refused submit is not a run)

### R3.7 · Right-click cut/copy/paste menu

- [ ] Right-click on the composer opens a small menu anchored at the click cell
- [ ] Paste is always offered; cut/copy only when a selection exists
- [ ] One click acts; a click outside closes it; Esc closes (consumed); any other
      key closes it and keeps its own meaning
- [ ] Cut/copy use the system clipboard; paste inserts the system clipboard through
      the field's own rules (multi-line paste behaves like a bracketed paste)
- [ ] Full menu on all five multi-line editors; paste (menu right-click) also works
      on the typed one-line fields: wizard api_key/base_url/model line, list
      searches, filters, the external llama URL draft
- [ ] Ctrl+V / Cmd+V paste chord works in the editor (for terminals that swallow
      right-click)
- [ ] The composer does NOT collapse while the menu is open (it is not a modal),
      and the menu never survives under a raised modal floor

### R3.8 · Fallback pane fixes

- [ ] LLM tab › Fallback: `<` `>` reorder, `d` remove, `l` toggle append-local and
      the add picker all PERSIST (re-open the pane / restart: the chain survives)
- [ ] An empty chain still shows the "+ add link" row (cursor never points at an
      invisible row); shrinking the chain re-clamps the cursor
- [ ] Chain rows / add row / picker rows are clickable (same activation as Enter)
- [ ] `/llm fallback` deep-links to the pane AND refreshes providers on arrival —
      config edited outside the app shows current, not stale, chain state
- [ ] The menu/slash description mentions the fallback pane

### R3.9 · Hosted stub llama-server (Vercel) — External connector

A public stub of a stock llama-server for end-to-end testing of the External
llama.cpp connector — happy path and the failure shapes that used to be silent —
from any machine, no local server needed.

Base URL: **https://llama-stub-vercel.vercel.app** (canonical URL only; hash
deployment URLs sit behind Vercel's deployment protection). Failure shapes are
path-prefix modes — one deployment, four base URLs (query strings are stripped
by the client, and no prefix ends in `/v1` because the client drops a trailing
`/v1`). The stub always answers `stream:true` in SSE framing.

Paste each URL into **LLM tab › External › Enter**:

| Base URL | Imitates | Expected in the app |
| --- | --- | --- |
| `https://llama-stub-vercel.vercel.app` | stock llama-server | saved; row `[healthy]`; status bar names `qwen3-30b-a3b-q4_k_m.gguf`; a chat turn answers "stub says hi" over SSE |
| `https://llama-stub-vercel.vercel.app/llama` | same server behind a reverse-proxy path prefix | saved with the path preserved (`/llama/health` probed, not origin `/health`); chat turn works |
| `https://llama-stub-vercel.vercel.app/auth` | `llama-server --api-key` (llama.cpp's real exemptions: `/health`, `/models`, `/v1/models`, `/api/tags` stay public) | refused at save time: "http 401 — the server requires an API key (--api-key). Set ATOMIC_AGENT_LLAMA_API_KEY in the state dir's .env and retry." |
| `https://llama-stub-vercel.vercel.app/openai` | OpenAI-compatible-only runner (LM Studio / Ollama / vLLM: `/v1/*` only, no `/health`) | refused with the redirect: "answers like an OpenAI-compatible server, not llama.cpp. Add it as a cloud provider instead: LLM tab › Cloud › n › openai-compatible…" |

The `/auth` key is `sk-stub-key` (`STUB_API_KEY` env on the Vercel project); set
`ATOMIC_AGENT_LLAMA_API_KEY=sk-stub-key` to test the accepted-key path.

Curl smoke:

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

Requests are logged (`method path auth`) — `npx vercel logs
llama-stub-vercel.vercel.app` or the Vercel dashboard. Stub source:
`~/claudecode1/llama-stub-vercel` (one catch-all function, `api/stub.mjs`).
