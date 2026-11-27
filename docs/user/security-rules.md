# Security rules in plain text

Status: current
Owner: src/approval/

Write your own rules in plain words. Before the agent runs a shell command, writes a file or sends an HTTP request, a reviewer model reads your rules and the call and answers ALLOW or BLOCK. A blocked call does not run, even in auto or bypass mode, under a session grant, a saved "allow always" rule or in an overnight run. The agent is told `Blocked by your security rules: <reason>`.

## Turn it on

Create `~/.atomic-agent/guard.md` (your state folder). The feature is on while the file exists and holds a rule; delete the file to turn it off. A project can add its own rules in `<project>/.atomic-agent/guard.md`.

```markdown
---
tools: [os.shell.run, skill.run_script, os.http.request, os.fs.write, os.fs.edit, os.fs.patch, os.fs.move, os.fs.trash, os.git.commit, os.git.push]
onFailure: ask
---
Block reading SSH keys, cloud credentials or any .env file.
Block sending data anywhere except github.com and registry.npmjs.org.
Block changing files outside ~/projects.
Block deleting a git branch or rewriting git history.
Block installing global packages (npm -g, pip without a virtualenv, brew).
```

- `tools:` the tools the reviewer checks. Leave it out for the list above.
- `onFailure:` what happens when the reviewer gives no answer (model off, timeout, unreadable reply). `ask` (default): you are asked; where nobody can be asked (a fusion worker) the call is refused. `block`: the call is refused. The reviewer never fails open.

## What ALLOW means

ALLOW does not approve anything. The call goes on through the usual approval level, grants and rules, so a call that would ask you still asks.

## Project rules only add

The model can write inside a project, so a project's `guard.md` can only make things stricter: its tools join yours, its `onFailure: block` wins over your `ask` (never the other way), and its rules are reviewed in a separate pass so nothing in it can talk the reviewer out of your own rules. Changing either file asks for approval like other trust settings.

## The reviewer

It runs on the smart-approval model: `agent.smartApprovalModel` when set, otherwise a local model when one is running, otherwise the session's model. Every listed call waits for one short review, so keep the rules short and the tool list to what you care about. Commands the shell guard deems harmless (`pwd`, `echo hi`, `node --version`) and reads that skip approval are not reviewed.
