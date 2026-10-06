# Process-level smoke after reorganization

Status: verified
Owner: repository maintainers

Run date: 2026-10-06. Build: atomic-agent 0.6.6, macOS, Node 25.7.0 with the installed native SQLite dependency. This checks actual `dist` processes, HTTP/SSE, filesystem effects and SQLite persistence. The LLM endpoints are local scripted servers; this does not measure model quality.

## Repeatable offline check

```sh
npm run build
npm run smoke:e2e -- --output /tmp/atomic-e2e-report
```

[Harness](../../scripts/smoke-e2e.mjs) uses only Node built-ins. It creates temporary state and workspace directories, supplies a clean child environment without inherited cloud credentials, disables analytics/browser and background memory features in the fixture config, and binds an ephemeral loopback port. Workspaces are removed after the run; JSON request evidence and process output remain in the selected output directory. It neither downloads models nor loads `eval/.env`. Loopback binding must be allowed by the execution environment. TUI and the extended eval/native-provider runs below were performed separately and are not part of this command.

The 13 assertions passed:

- Sidecar boot/ping/version; malformed NDJSON recovery and unknown-request response.
- Real file read reaches the next prompt; streamed reply is committed exactly once.
- Two reads in one batch; both results enter the prompt and persisted call order matches input order. Live result events can arrive in completion order.
- Denied approval prevents a write; accepted approval creates the expected file.
- Invalid completion triggers a unary repair request and one final reply.
- Concurrent host messages execute FIFO on one session.
- Steering reaches the next prompt while a turn is running.
- Cancellation closes a held HTTP inference connection; a newly created session works afterward.
- `finish` completes the session; shutdown plus stdin EOF exits normally.
- Completed transcript survives a full sidecar process restart through SQLite.
- Built CLI help/version start without inference.
- Built CLI run reads a real file, prints its reply and exits on EOF.

The harness also verifies that main inference/repair requests carry a grammar. Auxiliary session naming is handled separately and excluded from main-request selection. An independent harness review caught this potential race; the final script uses filtered selectors. Smoke assertions do not require parallel tool-result events to arrive in input order.

## Additional actual-process checks

CLI eval: 11 positive cases passed: read, grep, glob, new-file write, shell, git status, installed-skills list, skill loading and three coding changes. The coding tests used a temporary corrected stub selecting `os.fs.edit`; existing content expectations were retained. Two coding cases observed a batch of two reads. All positive processes exited 0 without timeout, parse retries or tool errors.

The unchanged existing canned eval subset passed 8 of 13 cases. Its five failed expectations remain failures: two localhost HTTP cases hit the mandatory SSRF guard; three coding cases use `os.fs.write` to overwrite an input explicitly named by the request and hit the input-file guard. Compiling original git HEAD `cce6262c` in a disposable checkout reproduced all five guard failures. The product protections were retained; the existing canned eval is not reported as entirely green.

OpenAI-compatible/native-tools: one additional CLI scenario passed, with exactly two streamed `/v1/chat/completions` requests. Fragmented tool arguments reconstructed into a real file read; the second request contained assistant tool-call history and the actual tool result in a tool-role message. There was one exact final answer, two steps, no parse retry/tool error and exit 0. No real key, remote provider, llama probe or embedding request was used.

TUI: three real PTY scenarios passed: first-run intro/backend choice/double Ctrl+C; main `/help` then `/quit`; MCP → Skills → Privacy navigation then `/quit`. All exited 0 without forced termination. Alternate screen and mouse modes were restored; the navigation run additionally verified terminal ICANON/ECHO restoration. Raw ANSI and decoded terminal output were captured. This is terminal interaction coverage, not screenshot or visual-layout review.

## Evidence and limits

[Evidence index](evidence/e2e-smoke/index.json) lists retained summaries, actual process/request logs and baseline comparison. The reproducible command above covers CLI/sidecar; additional-run harness snapshots are evidence from this session, not another supported test entry point.

No production TypeScript, algorithm, configuration default or prompt literal was changed for this smoke. Added files are a test harness, its command and documentation/evidence.

Still unverified: generation with an actual model; live cloud providers, provider/model hot swap and fallback; a successful outbound HTTP-tool request; real MCP servers; full Tauri-host integration; browser interaction; TUI mouse coordinates/resize/visual layout; Windows/Linux and packaged SEA binaries. Cancellation was tested with creation of a new sidecar session afterward, not resumption of the same cancelled session. Background memory behavior was disabled in the fixture. These limits prevent interpreting this smoke as a universal release guarantee.
