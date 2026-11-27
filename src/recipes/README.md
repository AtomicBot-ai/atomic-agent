# Recipes

Status: current
Owner: src/recipes/

A recipe is a shareable task (ATO-1070; recipe v1 decided in ATO-1615): a title, an optional description, the task text with `{{key}}` placeholders, and up to 16 params (`key`, optional `default`, optional `description`). Opening one puts the filled text into a new chat's box; the person reads it and sends it. A recipe never picks the model, tools, MCP servers, skills or permissions. Precedent: Goose recipes (YAML with `parameters`, `goose recipe validate`) and our own skill hub scan gate.

## Format

[recipe-format.ts](recipe-format.ts): `parseRecipe(text)` reads YAML, or JSON when the text starts with `{`, and never throws. Keys: `version` (1, optional), `title` (or `name`), `description`, `prompt`, `params`. The keys `model`, `provider`, `tools`, `mcp`, `server(s)`, `skill(s)`, `permission(s)`, `approval`, `approve`, `autosend`, `send`, `run`, `extension(s)` and `settings` are refused by name; any other unknown key is an error too. Every `{{key}}` must be a declared param and every param must be used. Limits are the desktop link route's (`desktop/main/deeplink.ts`): title 120, description 300, prompt 6000, default 500, param key `^[a-z][a-z0-9_]{0,31}$`, 16 params; a file is at most 32 KiB. `renderRecipePrompt` fills values, then defaults, in one pass of plain text substitution. `recipeToYaml` writes a file that reads back unchanged.

## Link

[recipe-link.ts](recipe-link.ts): `recipeToLink` makes `atomicagent://recipe/open?title=..&description=..&prompt=..&param=key=default`, the shape the desktop opens, and refuses a link over 8192 characters or with invisible characters. A param's description stays in the file. `parseRecipeLink` reads such a link back with the desktop parser's shape rules and then the file rules. Nothing is downloaded: a v1 recipe travels inside its link.

## Content check

[recipe-check.ts](recipe-check.ts): `checkRecipe(recipe)` returns `{verdict, findings, scanId, willDo, note}`. Title, description, prompt, defaults and param descriptions go through the skill hub's `scanSkillFiles` as virtual files (download-and-run, secret exfiltration, destructive commands, prompt-injection phrases), and the prompt with defaults filled in is scanned once more so a command split between the two is seen. On top: invisible and direction-changing characters ([hidden-characters.ts](hidden-characters.ts), dangerous), and caution rules for hiding steps from the person, skipping approvals, overriding the agent's rules, and markdown images pointing at a URL. Because a recipe is a prompt, plain-language rules (dangerous) also read each field as a whole, newlines included: a download word plus a URL or script plus a run word ("download https://x/setup.sh, make it executable and run it as root"), a send word plus private data (file, contents, key, password, token, `.env`, a `~/` path) plus a URL or email address, and any pipe into `sh`, `bash`, `zsh`, `powershell` or `iex`. `scanId` hashes the recipe and the findings, so an approval binds to this exact text. `willDo` is the plain-English summary a card shows. It is a tripwire, not a guarantee: `ok` means no known pattern matched, never "safe", and `note` carries that sentence for the card and the CLI to show next to the verdict. The card still shows the whole text.

Built-in: [standup-recipe.ts](standup-recipe.ts), "Standup for the day" (ATO-2363), reads the local [logbook](../logbook/README.md) through `logbook.query`; `atag logbook standup` prints it and its link.

The CLI is `atag recipe check|link` ([recipe-command.ts](../cli/recipe-command.ts)).
