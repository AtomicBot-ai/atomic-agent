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
- Keep `--gmail-no-send` on every `gog` call by default. The one exception
  is in "Gmail (via `gog`)" below: if that flag blocks draft creation
  itself, it may be dropped for an explicit draft request, and only for
  the draft command. Never drop it to get past any other error.
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
`gog-workspace` skill).

1. **Read the accepted flags first, do not guess them.** Run
   `gog schema gmail drafts --json` (or `gog gmail drafts create --help`
   if `schema` is not available) and use exactly the command name, flag
   names and command id it prints:

   ```json
   [{ "tool": "os.shell.run", "args": { "cmd": "gog", "args": ["schema", "gmail", "drafts", "--json"] } }]
   ```

2. **Create the draft with sending blocked**, for example (adjust to what
   step 1 printed):

   ```json
   [{ "tool": "os.shell.run", "args": { "cmd": "gog", "args": ["--json", "--no-input", "--account", "<email>", "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create", "gmail", "drafts", "create", "--to", "<recipient>", "--subject", "<subject>", "--body", "<body>"] } }]
   ```

3. **If `gog` rejects a flag**: if it says `--enable-commands-exact` is
   unknown, use the allowlist flag the schema or `--help` lists (for
   example `--enable-commands gmail.drafts.create`). If
   `--gmail-no-send` blocks draft creation itself, you may run the same
   draft command again without `--gmail-no-send`, because the user asked
   for a draft. This is the only case where the flag may be dropped. The
   command must still be the draft-create command: never call `gmail send`
   or any send, schedule or queue command, and never send the draft.
4. If it still fails, stop, tell the user what `gog` said, and write the
   draft to a local file instead (see "No mailbox set up").

Each call goes through the approval gate, so the user sees every draft
before it is saved.

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
