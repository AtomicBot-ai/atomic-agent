# Starter skills

These folders are **installed automatically** into your global skills directory
(`<stateDir>/skills/<name>/`, default `<stateDir>` = `~/.atomic-agent`) on every
agent runtime boot. Existing directories with the same name are **replaced** by
the bundled copy so upgrades refresh starter `SKILL.md` files.

Override the source tree with `ATOMIC_AGENT_STARTER_SKILLS_DIR` pointing at a
directory that contains the same layout (e.g. `duckduckgo-search/SKILL.md`).

Do not reuse a **built-in starter skill name** for unrelated custom work under
the global skills dir — it will be replaced on the next boot. Use a distinct
`name` or a project-local `.atomic-agent/skills/` tree instead.
