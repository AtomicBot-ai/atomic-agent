# Deep research

Status: current
Owner: src/tools/research/

`research.deep` (ATO-2133) answers a question from several web pages and keeps only what it can check. Read the inherited [tool instructions](../AGENTS.md) and [tool contract](../docs/contracts.md) first. Registration is in [runtime-tool-catalog.ts](../../runtime/composition/runtime-tool-catalog.ts); the descriptor, schema and compact form sit beside `files.search` in the prompt catalog.

## Flow

1. [research-args.ts](research-args.ts): `question`, `maxSubQuestions` 1..5 (default 3), `pagesPerQuestion` 1..3 (default 2). Fixed budgets: at most 12 pages per run, `maxChars` 20 000 per fetch, 12 000 characters of a page shown to the model, 3 findings per page.
2. [research-model.ts](research-model.ts): three side calls on the model `browser.extract` uses (same request builder and JSON reader, `browser-extract:` fallback partition): plan the sub-questions, read `{claim, quote}` findings off one page, summarise the verified findings. Calls are queued one at a time, since a local link has one side slot. An unreadable plan researches the question itself.
3. [research-gather.ts](research-gather.ts): per sub-question, `os.web.search` then `os.web.fetch` through the registry's own `invoke`, so their approvals, offline mode, SSRF guard, taint report and untrusted framing apply exactly as on a model call. Sub-questions run three at a time; a URL two searches return is fetched once. A page that fails (HTTP error, bot wall, denied approval, a model error) is named under "Sources not read"; cancellation stops the run.
4. [evidence-check.ts](evidence-check.ts) and [verify-findings.ts](verify-findings.ts), pure: a quote must appear in the fetched text after normalization (NFKC, typographic quotes and dashes, whitespace, case); "..." splits it into pieces that must appear in order; under 20 characters is too short. Every number in the claim must be in the quote (also across scale words: 1.2 million = 1,200,000) or follow from two quote numbers as a sum, difference or percentage. A direct match needs the same scaled value and percent flag; years (1900..2100) are never operands, and a sum or difference needs both operands with the same unit word. Anything else is unverified, with its reason.
5. [contradictions.ts](contradictions.ts), pure: verified findings on the same sub-question from different pages with the same unit and the same years (or none), more than 5% apart. It flags, it does not pick a side.
6. [research-report.ts](research-report.ts): Markdown with Summary, Findings (link and exact quote, computed numbers), Contradictions, Unverified claims, Sources not read. The tool writes it as `research-<slug>-<stamp>.md` in the working folder through `requireFsApproval` (kind `write`, never overwrites) and returns it framed as outside text. When saving is declined or the write fails, the report is still returned, with a "not saved" line instead of the path.

The fusion judge ([judge.ts](../fusion/judge.ts)) was not reused: it rules on a delegate contract's acceptance list and has no shape for source-versus-source claims. A model judge pass over contradictions is a follow-up.

## Posture

`approval_gated` and solo at every level (a fan-out inside one call), asking as fs write for the report and `http` / `http_write` through its fetches. Not read-only, so plan mode does not run it. Hidden with `os.web.search` when web search is off, and from fusion workers. The TUI `/research <question>` sends an ordinary message that asks for the tool ([research-command.ts](../../tui/commands/research-command.ts)).

Follow-ups: an "only my documents" mode over `files.search`, a report card in the desktop app, and a judge pass on flagged contradictions.

## Validation

`npx vitest run src/tools/research src/tui/commands/research-command.test.ts src/tools/tool-contract-conformance.test.ts src/agent/tool-resource-class.test.ts`; `npm run lint`; `npm run docs:check`.
