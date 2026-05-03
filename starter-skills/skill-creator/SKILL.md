---
name: skill-creator
description: Author or edit atomic-agent skills (SKILL.md + YAML). Use when creating, renaming, or tightening skills and their install layout.
version: 1.3.0
requires_tools:
  - os.fs.read
  - os.fs.write
  - os.fs.list
dangerous: false
---

# skill-creator

## Critical — invalid files are skipped at load

`SKILL.md` **must** start with the bytes `---` then a newline, YAML mapping, closing `---` line, then markdown body.

If the file starts with `# Title` or prose **without** that frontmatter block, the runtime **drops** the skill (parse error); it will not appear in `### skills`.

## Minimal valid template (copy and edit)

```markdown
---
name: my-skill-name
description: One line when to load this skill and what it does (English ok).
version: 1.0.0
requires_tools: []
requires_scripts: []
dangerous: false
---

# my-skill-name

Body here. Use real tool names: `skill.view`, `os.http.request`, `browser.search`, …
```

Rules:

- `name` — kebab-case, **same string as the parent folder** (`my-skill-name/SKILL.md` → `name: my-skill-name`).
- `description` and `version` — required non-empty strings.
- `requires_tools` / `requires_scripts` — optional lists (documentation); omit empty keys if you prefer.

## Where to write files

| Scope | Path |
|-------|------|
| Global | `<stateDir>/skills/<name>/SKILL.md` (default `~/.atomic-agent/skills/`) |
| Project | `<workingDir>/.atomic-agent/skills/<name>/SKILL.md` — overrides global on name clash |

One folder per skill; single `SKILL.md` at folder root.

## Workflow

1. Create folder + `SKILL.md` using the template above (frontmatter first).
2. Keep `description` short; put procedures in the body (visible only after `skill.view`).
3. Restart the agent / call `refreshSkills` so the registry rescans disk.
4. Verify with `atomic-agent skill list` (shows `WARN:` lines for broken dirs).

## Do not

- Skip YAML — **ever**.
- Put secrets in the file or instruct bypassing approvals / HTTP allowlists.
