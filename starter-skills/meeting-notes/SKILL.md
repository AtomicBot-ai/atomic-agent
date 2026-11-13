---
name: meeting-notes
description: "Turn a meeting transcript or recording into minutes: summary, decisions, action items with owners and dates. Use for meeting notes, call notes, protocol, minutes, recap of a call."
version: 1.0.0
requires_tools:
  - os.fs.read
  - os.fs.write
dangerous: false
---

# meeting-notes

Write the minutes of one meeting from what was actually said: a short
summary, the decisions, and the action items. Save them as a Markdown file
next to the recording or transcript, then offer to put the action items on
the schedule.

## When to use

- "Make notes / minutes / a protocol / a recap of this meeting / call."
- "What did we decide?", "who does what after this call?"
- The input is a transcript file (`.txt`, `.md`, `.vtt`, `.srt`, `.docx`,
  `.pdf`), pasted transcript text, or an audio / video recording of a meeting.

## When NOT to use

- One person's voice memo with no meeting in it: just transcribe it
  (`audio-transcribe`) and answer.
- The user wants the full transcript, not minutes: that is
  `audio-transcribe`.

## Step 1: get the transcript

- **Audio or video file** (`.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`,
  `.webm`, `.mp4`, `.mov`): load the `audio-transcribe` skill and follow it to
  write `<recording>.txt` next to the recording. Video goes through `ffmpeg`
  to audio first if whisper refuses it.
- **Transcript file**: read it whole. Use `os.fs.read` for text and
  subtitle files, `os.fs.read_document` for `.docx` / `.pdf`. A long file is
  read in parts until the end; never write minutes from the first part only.
- **Pasted text**: use it as is.

If there is no transcript and no recording, ask for one. Do not write minutes
from memory or from the title of a file.

## Step 2: write the minutes

Write in the language of the meeting. Keep this exact layout, so the file
reads the same every time and other tools can find the parts:

```markdown
# Meeting notes: <topic in a few words>

- **Date:** <date said in the meeting, or the file date, or "not stated">
- **Participants:** <names as they appear in the transcript, or "not stated">
- **Source:** <file name of the recording or transcript>

## Summary

<3 to 6 sentences: what the meeting was about and where it ended up.>

## Decisions

1. <Decision, one line, in plain words.>

## Action items

| # | Task | Owner | Due |
|---|------|-------|-----|
| 1 | <what has to be done> | <name or "unassigned"> | <date or "not set"> |

## Open questions

- <Something raised and left without an answer.>
```

Rules:

- **Only what was said.** Every decision and task must be in the transcript.
  Do not add tasks the meeting did not agree on, owners nobody named, or due
  dates nobody gave. Unknown is written as `unassigned` / `not set` /
  `not stated`.
- A **decision** is something agreed ("we go with X", "we drop Y"). An idea
  that was only discussed goes to Summary or Open questions, not Decisions.
- An **action item** is a concrete next step someone takes. Start it with a
  verb. One task per row; split "A and B" into two rows when two people own
  them.
- Relative dates ("next Friday", "tomorrow") become real dates when the
  meeting date is known; otherwise keep the words as said.
- Write `None.` under a section that has nothing, instead of dropping it.
- Speaker labels like `SPEAKER_01` stay as they are unless the transcript
  says who they are.

## Step 3: save the file

Write the minutes next to the source, named after it:
`<source name without extension>.notes.md` (for `standup.m4a` that is
`standup.notes.md`). For pasted text, save `meeting-notes-<YYYY-MM-DD>.md`
in the working directory. If the file already exists, ask before
overwriting it.

```
[{ "tool": "os.fs.write", "args": { "path": "standup.notes.md", "content": "# Meeting notes: ..." } }]
```

Then reply with the summary, the decisions and the action items table, and
the path of the saved file.

## Step 4: offer reminders (ask first)

End the reply with one question: should any action item with a due date be
put on the schedule? Never schedule without a yes. On yes, create one
reminder per chosen item with `tasks.schedule` (see its description for the
arguments): `userMessage` is the task with its owner, `at` is the due date
in Unix milliseconds at 09:00 local time, and `newSession: true` so the
reminder does not land in this chat. Use the `apple-reminders` skill instead
when the user asks for Apple Reminders.
