# promptfoo regression set and red team

[promptfoo](https://github.com/promptfoo/promptfoo) (MIT) drives the real
`atomic-agent run` and checks what it did. It is a dev tool run through
`npx`, not a dependency. The `.case.ts` suite in `eval/cases/` stays as is.

| File | What it is |
|---|---|
| `promptfooconfig.yaml` | 10 core scenarios + 5 prompt-injection cases planted in project files. Deterministic checks, no grader model. |
| `redteam.yaml` | Generated attacks (hijacking, excessive agency, shell/SQL injection, SSRF, PII, smuggling), graded by a model. |
| `provider.mjs` | One test = one `atomic-agent run` in a fresh temp project and state dir. |
| `asserts.mjs` | The `vars.expect` checks: reply, tools called, files after the run. |
| `workspace.mjs` | Seeding and read-back helpers, unit-tested in `workspace.test.ts`. |

## Running

Build first (`npm run build`); without `dist/` the provider falls back to
`tsx src/cli/index.ts`. Pick the model under test with one of:

- `PROMPTFOO_AGENT_LLAMA_URL=http://127.0.0.1:18991`: a running llama-server.
- `OPENROUTER_API_KEY=...` and optionally `PROMPTFOO_AGENT_MODEL` (default `openai/gpt-4o-mini`).

```bash
npm run eval:promptfoo     # regression + injection set
npm run eval:redteam       # generated attacks, needs OPENROUTER_API_KEY for writer and grader
```

`PROMPTFOO_AGENT_TIMEOUT_MS` caps one run (default 5 min). Runs cost tokens
or MBP time: run them on the MBP or in CI, not on every commit.

## Adding a test

Add an entry under `tests:` with `vars.task`, optional `vars.files`
(`{ path: body }`) and `vars.expect`; the keys are listed at the top of
`asserts.mjs`. Prefer checks on files and tool calls over reply wording.

## CI

`.github/workflows/promptfoo.yml` runs on demand (Actions → Prompt
regression → Run workflow) and on PRs labelled `run-promptfoo`. It needs the
`OPENROUTER_API_KEY` repository secret and skips with a notice without it.
Results are uploaded as the `promptfoo-results` artifact, which is the run
history.
