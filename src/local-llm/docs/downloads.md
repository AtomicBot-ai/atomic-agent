# Detached and resumable downloads

Status: current
Owner: src/local-llm/

Download jobs survive the UI process. The job registry records progress/state while detached workers own transfer attempts. Preserve resumable partial files, segmented download coordination, job staleness detection and paired model/projector downloads. Installation and download completion are separate from server launch.

Pause and cancel differ only in the partial file: pause keeps it and records `paused`, which nothing resumes by itself (not launch-time adoption, not staleness), and cancel deletes it. Resume is an ordinary relaunch onto the partial.

Progress, retry and completion notices must reflect the worker's recorded outcome. Reopening a panel does not justify duplicating a download or replacing a live job. Platform paths and process invocation must work on Windows as well as POSIX.

Sources: [jobs](../downloads/download-jobs.ts), [worker](../downloads/download-worker.ts), [transfer](../downloads/download-file.ts), [spawn](../downloads/download-spawn.ts), [paired worker](../downloads/download-worker-pair.ts), [pause/resume/cancel](../downloads/download-job-control.ts). Tests: [jobs](../downloads/download-jobs.test.ts), [transfer](../downloads/download-file.test.ts), [pause/resume/cancel](../downloads/download-job-control.test.ts).
