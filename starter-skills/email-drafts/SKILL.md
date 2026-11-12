---
name: email-drafts
description: "Write outreach or follow-up emails as drafts in Gmail or as local files for Atomic Mail. Drafts only: never sends, the user reviews and sends each one."
version: 1.0.0
requires_tools:
  - os.shell.run
  - os.fs.write
  - os.fs.read
dangerous: false
---

# email-drafts

Write emails the user will send themselves: cold outreach to a lead list,
follow-ups, replies, partnership notes. This skill **only creates drafts**.

## The rule: drafts only, always

- **Never send.** Do not call `os.email.send`. Do not run any `gog gmail
  send` command or any command that sends, schedules or queues mail. This
  holds even when the user says "send them": answer that this skill only
  drafts and that they send from their mail client after reading each one.
- Never remove the `--gmail-no-send` flag from a `gog` call to get past an
  error. If a draft command is refused, stop and tell the user.
- One draft per recipient. No BCC blasts, no mail merge that sends.

## Inputs

- **Who**: a list (for example a CSV from the `lead-research` skill) or
  names and addresses in the message. Skip anyone on
  `./leads/suppression.csv` if it exists.
- **Why**: the offer or ask, in the user's words, plus any facts they want
  used (product, numbers, links). Use only facts the user gave or that are
  in the recipient's row with a source. Do not invent mutual contacts,
  past conversations, compliments about work you did not read, or results.
- **From**: which mailbox. Gmail (through the `gog-workspace` skill's `gog`
  CLI) or Atomic Mail (the agent's own inbox).

## Writing

- Subject under about 60 characters, specific, no clickbait, no "Re:" on a
  first email.
- Body 50 to 150 words for a first email. One idea, one ask, one link at
  most. Plain text.
- Personalise from the recipient's row: what their company does and why it
  fits, with the fact you used. If the row has nothing specific, write a
  plain version and say it is generic.
- Make opting out easy: end cold emails with a line like "If this is not
  relevant, reply and I will not write again."
- Run the text through the `plain-writing` rules: no long dashes, no stock
  phrases.

## Where drafts go

### Gmail (via `gog`)

`gog` needs to be installed and signed in with Gmail access (see the
`gog-workspace` skill). Read the exact draft flags from the installed
binary first, do not guess them:

```json
[{ "tool": "os.shell.run", "args": { "cmd": "gog", "args": ["schema", "gmail", "drafts", "--json"] } }]
```

Then create each draft with only the draft command allowed and sending
blocked, for example:

```json
[{ "tool": "os.shell.run", "args": { "cmd": "gog", "args": ["--json", "--no-input", "--account", "<email>", "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create", "gmail", "drafts", "create", "--to", "<recipient>", "--subject", "<subject>", "--body", "<body>"] } }]
```

Adjust the flag names to what `gog schema` printed. Each call goes
through the approval gate, so the user sees every draft before it is
saved.

### Atomic Mail

The agent's Atomic Mail tools can send but cannot save drafts. So for
Atomic Mail, write each draft to a local file and do not call
`os.email.send`:

```
./drafts/<YYYY-MM-DD>-<recipient-slug>.md
```

with `To:`, `Subject:` and the body. The user opens the file and sends it
themselves from Atomic Mail.

### No mailbox set up

Write the same local files and say which setup would put them in Gmail.

## Report

A table: recipient, subject, where the draft is (Gmail drafts or file
path), and the fact used for personalisation. Say plainly that nothing was
sent.
