# Security Policy

Atomic Agent runs shell commands, edits files and drives a browser on your machine, so we treat security reports as our top priority. Thank you for helping keep users safe.

## Reporting a vulnerability

Please do not open a public issue, pull request or Discord post for a security problem.

Report it privately in one of two ways:

1. **GitHub private vulnerability reporting (preferred).** Open [Security → Report a vulnerability](https://github.com/AtomicBot-ai/atomic-agent/security/advisories/new) in this repository. Only the maintainers can see the report, and we can work on the fix and the advisory with you there.
2. **E-mail:** [support@atomicbot.ai](mailto:support@atomicbot.ai). Put `SECURITY` at the start of the subject line.

Please include:

- the version (`atomic-agent --version`, or the desktop release you installed) and your OS;
- what an attacker can do, and what they need first (a malicious web page, a crafted repository, a hostile MCP server, local access, and so on);
- steps to reproduce, ideally a minimal proof of concept;
- any logs or traces, with your own keys removed.

## What happens next

- We confirm we received the report within 3 business days.
- We send a first assessment (whether we can reproduce it and how severe we think it is) within 10 business days.
- We keep you updated until it is fixed, and we tell you before anything is published.
- Once a fix is released, we publish a GitHub security advisory and credit you by name or handle, unless you ask us not to.

Please give us a reasonable time to ship a fix before you disclose the issue publicly. We aim to fix critical issues within 30 days.

## Supported versions

We fix security issues in the latest release of:

- the terminal agent (`v0.x` releases, installed with the install script or a Linux package);
- the desktop app (`desktop-v0.x` releases).

Both update in place. Please check that a problem still happens on the latest release before you report it.

## Scope

In scope, for example:

- a way to run a command, write or delete a file, send a message or submit a form **without the approval prompt** the action should show;
- a prompt injection (from a web page, a file, a repository, an e-mail or an MCP tool result) that gets around an approval, a blocked command or a read-scope check;
- a way to read the agent's own secrets (`<stateDir>/.env`, `config.json`, provider keys) without the prompt that should guard them, or to get them past the masking of secrets in tool output;
- a way for a project folder to grant itself permissions it should not have;
- data leaving the machine in a way the [README](README.md#privacy-and-egress) does not describe, including through analytics or crash reports;
- problems in the installer, the update flow, or the signing and checksums of release files.

Out of scope:

- actions you approved, or that run unasked because you chose a higher approval level, a session grant or an "always allow" rule;
- at approval level 5 (full trust), or in an overnight run started with `--no-approval`, the agent doing what it is asked;
- what a skill, a shell command or an MCP server you installed and allowed does on its own;
- a model giving wrong or harmful answers without crossing a security boundary;
- issues in third-party services (model providers, MCP servers, websites) that are not caused by Atomic Agent;
- the atomicagent.io website, unless it affects the agent or its downloads (report those to the same contacts, and we will route them).

## Safe harbor

We will not take legal action against research done in good faith under this policy: test only on your own machine and accounts, do not access other people's data, do not degrade our services, and give us time to fix the issue before you disclose it.

## More

How the agent protects you (approvals, Trash instead of delete, blocked commands, telemetry and signed builds) is described at [atomicagent.io/security](https://atomicagent.io/security) and in the [Safety and Observability](README.md#safety-and-observability) section of the README.
