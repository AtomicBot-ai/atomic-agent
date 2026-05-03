---
name: wttr-weather
description: Weather via wttr.in GET (no key). Use for weather/forecast; prefer os.http.request.
version: 1.1.0
requires_tools:
  - os.http.request
  - os.shell.run
dangerous: false
---

# wttr-weather

`os.http.request` **GET** (allowlist must include `wttr.in` if not null):

- `https://wttr.in/<Place>?format=3` — one-line text  
- `https://wttr.in/<Place>?format=j1` — JSON  
- No place: `https://wttr.in/?format=3`  
- Metric/imperial: append `&m` or `&u`

No `wttr` binary. No `skill.run_script`. Fallback: `curl -fsS --max-time 25 '<url>'` via `os.shell.run`.
