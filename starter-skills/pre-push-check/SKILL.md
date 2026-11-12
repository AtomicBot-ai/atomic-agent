---
name: pre-push-check
description: Before os.git.push of your own code, ask the user three short questions about it. Use for /pre-push-check.
version: 1.0.0
requires_tools:
  - os.git.diff
  - os.git.log
dangerous: false
---

# pre-push-check

A push sends code into a shared place where other people build on it. If
the agent wrote that code, the person pushing often has not read it. This
check takes a minute: three questions about the diff, answered by the
human, before the push goes out.

The user can turn this off at any time with `/skill disable pre-push-check`
(or the switch on the Skills screen) and back on with
`/skill enable pre-push-check`.

## When it applies

Run the check before `os.git.push` (or `git push` through the shell) when
the commits being pushed contain code you wrote or edited in this session.

Skip it, and push as asked, when:

- the user says "skip the check", "just push" or similar, now or earlier in
  this session for the same commits;
- nothing in the push came from you (the user's own commits, a merge of
  someone else's branch, a tag);
- the push only touches docs, comments or formatting;
- the user already answered the check for these same commits in this
  session.

The check never replaces the normal push approval and never blocks a push
the user insists on.

## How to run it

1. **Look at what goes out.** `os.git.log` for the commits not yet on the
   remote branch, `os.git.diff` for their combined change. Note the files
   you touched and the behaviour that changed.
2. **Write three questions**, one of each kind, about this diff and nothing
   else:
   - **What changed**: about a concrete behaviour. Not "what does this PR
     do?" but "After this push, what happens when a user opens the app with
     no config file?"
   - **What could break**: about the riskiest line you wrote. "The retry
     loop in `sync.ts:88` now runs up to five times. What does the user see
     if the server is down for a minute?"
   - **How to check it**: "Which command or click would show this works?"
     Have a real answer ready: a test name, a command, a screen.
   Keep each question to one or two sentences, in the user's language, in
   plain words. Name files with `path:line` so they can look.
3. **Ask all three in one message** and wait. Say they can answer in a
   few words, and that "skip" pushes without the check.
4. **Compare each answer with what the code does.**
   - Right or close enough: say so in a few words.
   - Wrong or "I don't know": explain the real answer in two sentences,
     pointing at the line. This is the point of the check, so be kind and
     concrete, not a grader.
   - An answer that shows the change does something the user did not
     want: stop, say so, and ask whether to fix it before pushing.
5. **Then push** with `os.git.push` as originally asked. The usual approval
   prompt still shows.

## Rules

- Exactly three questions. No quizzes on code the user wrote themselves.
- Never invent behaviour to ask about. Every question and every expected
  answer must come from the diff you read in step 1.
- Do not lecture, score or repeat the questions after they answered.
- If the user ignores the questions and asks again to push, push.
