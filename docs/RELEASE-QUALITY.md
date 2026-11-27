# Release quality: bug severity and the UI release rule

Status: current
Owner: repository maintainers

This page says how bad a bug is, how fast it gets fixed, and when a bug stops a release. It covers the desktop app and the terminal (`atag`).

## Severity levels

| Level | What it means | Examples in Atomic Agent |
| --- | --- | --- |
| P0 | The app cannot be used, or the user loses data. | The desktop app does not start, or the window opens blank and is never drawn. `atag` crashes on launch. Chats, memory, skills or settings are lost or overwritten after an update. The installer or the update leaves the app broken. |
| P1 | A main flow is broken, or a main screen looks broken. | Onboarding cannot be finished. A message cannot be sent or the answer never shows. A model cannot be downloaded or picked. Navigation or the sidebar is clipped so items cannot be reached. Text in the dark theme is unreadable. Settings do not open, or a main screen is broken on Windows only. |
| P2 | Something is wrong, but there is a workaround or it sits off the main path. | A secondary Settings page shows wrong state until reopened. A rare error shows a raw message instead of plain words. A layout breaks only at an unusual window size or scaling. A keyboard shortcut is wrong on one OS. |
| P3 | Polish. Nothing is blocked. | Spacing or alignment is off by a few pixels. A typo. An icon is slightly blurry. An animation stutters. |

When unsure between two levels, pick the higher one and say why in the issue.

## Fix targets

- P0 and P1: fixed within 48 hours of being reported.
- P2 and P3: fixed within 7 days.

Precedent: Linear's [zero-bugs policy](https://linear.app/now/zero-bugs-policy) fixes every bug within a short, fixed window instead of keeping a bug backlog.

## The release rule

No release ships with an open P0 or P1 bug in the UI.

Shipping with a known P0 or P1 is an exception. Only the product owner decides it. The decision is written as one line in the release checklist, and the bug is named in the release notes.

## UI gates before a release

All three must be green before a release is published:

1. The screenshot diff report was reviewed. Every changed screen is either an intended change (baselines updated in the PR) or filed as a bug with a level from this page.
2. The color contrast test and the stylelint raw-color gate are green.
3. The live smoke is green.

## Where this is used

- The [pull request template](../.github/pull_request_template.md) asks for a before and after screenshot or video on every UI change, with light theme, dark theme and Windows checked.
- The [bug report form](../.github/ISSUE_TEMPLATE/bug.yml) asks for the version, the OS and the last version where it worked, which helps set the level.
