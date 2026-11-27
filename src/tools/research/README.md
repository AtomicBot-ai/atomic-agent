# Deep research

Status: current
Owner: src/tools/research/

`research.deep` (ATO-2133, ATO-2507) answers a question from several web pages or from the person's documents in My files, and keeps only what it can check. Read the inherited [tool instructions](../AGENTS.md) and [tool contract](../docs/contracts.md) first. Registration is in [runtime-tool-catalog.ts](../../runtime/composition/runtime-tool-catalog.ts); the descriptor, schema and compact form sit beside `files.search` in the prompt catalog.

## Flow

1. [research-args.ts](research-args.ts): `question`, `sources` (`web`, `documents`, `both`), `folder` (documents only; alone it means `documents`), `maxSubQuestions` 1..5 (default 3), `pagesPerQuestion` 1..3 (default 2), `maxMinutes` 1..30 (default 10). Fixed budgets: at most 12 pages per source per run, `maxChars` 20 000 per fetch, 12 000 characters of a page shown to the model, 3 findings per page.
2. [research-source-choice.ts](research-source-choice.ts): without `sources`, the web while `web.search.enabled` is on, else the documents when My files has a folder (as OpenClaw keeps to given documents unless the web is asked for). An asked source that cannot run is a plain error: web search off, no My files, no folders.
3. [research-model.ts](research-model.ts): four side calls on the model `browser.extract` uses (same request builder and JSON reader, `browser-extract:` fallback partition): plan the sub-questions, read `{claim, quote}` findings off one page or passage, judge a flagged pair, summarise the verified findings. Calls are queued one at a time, since a local link has one side slot. An unreadable plan researches the question itself.
4. [research-sources.ts](research-sources.ts) and [research-gather.ts](research-gather.ts): per sub-question and source. Web: `os.web.search` then `os.web.fetch`. Documents: `files.search` (with `folder`), then the index's own text of each hit's PDF page or file (`FileIndex.passageText`, at most 400 000 characters); a long file is shown to the model around the hit's snippet. Both go through the registry's `invoke`, so approvals, read scope, guest rules, offline mode, SSRF guard, taint report and untrusted framing apply exactly as on a model call. A document finding links to the same `file://` URL `files.search` cites (`#page=N`), so the desktop draws it as a citation chip. Sub-questions run three at a time; a page two searches return is read once. A page that fails (HTTP error, bot wall, denied approval, a passage gone from the index, a model error) is named under "Sources not read"; cancellation stops the run.
5. [evidence-check.ts](evidence-check.ts) and [verify-findings.ts](verify-findings.ts), pure: a quote must appear in the page or passage text after normalization (NFKC, typographic quotes and dashes, whitespace, case); "..." splits it into pieces that must appear in order; under 20 characters is too short. Every number in the claim must be in the quote (also across scale words: 1.2 million = 1,200,000) or follow from two quote numbers as a sum, difference or percentage. A direct match needs the same scaled value and percent flag; years (1900..2100) are never operands, and a sum or difference needs both operands with the same unit word. Anything else is unverified, with its reason.
6. [contradictions.ts](contradictions.ts), pure: verified findings on the same sub-question from different pages with the same unit and the same years (or none), more than 5% apart.
7. [research-judge.ts](research-judge.ts): one side call per flagged pair (the first 5) reads both exact quotes and rules `conflict`, `different_measures` or `unclear` with one sentence. It labels a flag, never removes one and never picks a side; a failed call leaves the pair "Not judged". The fusion judge ([judge.ts](../fusion/judge.ts)) rules on a delegate's acceptance list and is not reused.
8. `maxMinutes` is checked before each search, page and judge call (a running fetch is not cut). When it runs out, the report starts with "Stopped early" and covers what was read. Money is not priced here: inside a scheduled task, the task's own budget (`tasks/task-budget.ts`, ATO-1108) caps the run's spend and time.
9. [research-report.ts](research-report.ts): Markdown with the sources line, Summary, Findings (link and exact quote, computed numbers), Contradictions (with the judge's line), Unverified claims, Sources not read. The tool writes it as `research-<slug>-<stamp>.md` in the working folder through `requireFsApproval` (kind `write`, never overwrites) and returns it framed as outside text. When saving is declined or the write fails, the report is still returned, with a "not saved" line instead of the path.

## Hosts

The chat's `tool_result` frame carries `research` ([research-frame.ts](../../http/research-frame.ts)): `reportPath` (or `null`), `question`, `sources` and the counts, for the desktop's report card. The session store keeps no `details`, so a reopened chat reads the report path off the stored summary's first line.

## Posture

`approval_gated` and solo at every level (a fan-out inside one call), asking as fs write for the report and `http` / `http_write` through its fetches. Not read-only, so plan mode does not run it. Offered while web search is on or `files.search` is registered (`filter-disabled-tools.ts`, gate `research`); hidden from fusion workers. The TUI `/research [--docs | --both] <question>` sends an ordinary message that asks for the tool ([research-command.ts](../../tui/commands/research-command.ts)).

## Validation

`npx vitest run src/tools/research src/tools/files/file-index.test.ts src/http/research-frame.test.ts src/runtime/filter-disabled-tools.test.ts src/tui/commands/research-command.test.ts src/tui/menu/menu-registry.test.ts src/tools/tool-contract-conformance.test.ts src/agent/tool-resource-class.test.ts`; `npm run lint`; `npm run docs:check`.
