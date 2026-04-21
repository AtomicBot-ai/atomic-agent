# Skills

`atomic-agent` ships **без** встроенных скилов. Скилы — это локально устанавливаемые «плейбуки»: описание задачи в markdown плюс опциональные shell/Node-скрипты. Формат вдохновлён Hermes Agent и OpenCUA Operator: прогрессивная загрузка (`skill.view`) не раздувает KV-кэш промпта, а скрипты исполняются только с явного одобрения пользователя.

## Формат на диске

```
<skill-root>/
  SKILL.md           # обязательный: YAML frontmatter + markdown тело
  scripts/           # опционально: shell/node/bash-скрипты
    *.sh | *.ts | *.js | *.mjs | *.cjs
  references/        # опционально: статические файлы, которые агент читает `os.fs.read`
```

## Frontmatter

```yaml
---
name: check-gmail-inbox          # обязательный, kebab-case, уникальный
description: "Check Gmail inbox" # обязательный, ≤ ~200 символов
version: 0.1.0                   # обязательный, свободная строка (SemVer рекомендуется)
requires_tools:                  # информационный список tool'ов, которые скилл ожидает
  - browser.navigate
  - browser.read_aria
requires_scripts:                # только эти имена можно запускать через skill.run_script
  - fetch-headers.sh
dangerous: true                  # если true — фиксирует, что скилл опасный (для человека-читателя)
---
```

Валидация:

- `name` соответствует `^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$`.
- Все поля строго типизированы, списки должны содержать непустые строки.
- Неизвестные ключи игнорируются (forward-compat), но некорректные типы — это ошибка.

## Места установки

| Источник   | Путь                                 | Когда побеждает |
| ---------- | ------------------------------------ | --------------- |
| `project`  | `./.atomic-agent/skills/<name>/`     | всегда, если присутствует |
| `global`   | `$ATOMIC_AGENT_STATE_DIR/skills/<name>/` | fallback        |

Project-local скилл с тем же `name` оверрайдит глобальный. Это позволяет коммитить скилл рядом с репозиторием пользователя и переопределять его локальной версией.

## CLI

```sh
atomic-agent skill install <path>       # копирует <path> в глобальный каталог
atomic-agent skill install <path> --force
atomic-agent skill uninstall <name>     # удаляет глобальный скилл
atomic-agent skill list                 # показывает установленные (project / global)
atomic-agent skill show <name>          # печатает SKILL.md с путём
```

Установка — это валидация `SKILL.md` плюс `cp -r`. Никаких внешних загрузок и сетевых источников в MVP: пользователь сам готовит папку со скилом.

## Инструменты агента

- `skill.view({ name })` — читает `SKILL.md`, отбрасывает frontmatter и кладёт тело скилла в `session.loadedSkills`. Повторный `skill.view` того же скилла не увеличивает токены в промпте (кэшируется на сессию). Read-only, approval не требуется.
- `skill.run_script({ skill, script, args?, timeoutMs? })` — запускает `scripts/<script>`. Разрешены только скрипты, перечисленные в `requires_scripts`; любой путь вне `scripts/` отбивается. Всегда **dangerous**: уходит через approval gate, preview включает имя скилла, путь скрипта и аргументы.

Расширения (`.ts`, `.js`, `.mjs`, `.cjs`) запускаются через `node`, `.sh` — через `bash`, остальное — напрямую (shebang/исполняемый файл).

## Промпт и KV-кэш

Стабильный префикс промпта содержит только `name: description` установленных скилов (см. `src/prompt/stable-prefix.ts`). Тело скилла попадает в промпт **только** после `skill.view` и остаётся там до конца сессии как стабильная часть tail — это одна инвалидация KV-кэша на сессию, не на каждый шаг.

## Пример: `echo`

```
echo/
  SKILL.md
  scripts/
    say.js
```

`SKILL.md`:

```markdown
---
name: echo
description: "Echo CLI arguments back to stdout"
version: 0.1.0
requires_scripts: [say.js]
dangerous: false
---

Запусти `skill.run_script` с `skill: echo`, `script: say.js` и произвольными `args`. Скрипт распечатает `"said <args>"`.
```

`scripts/say.js`:

```js
process.stdout.write("said " + process.argv.slice(2).join(" "));
```

## Явные границы

- Скилы — это **данные + скрипты**, не плагины: нельзя динамически регистрировать новые tool'ы или `require` нативные модули.
- Нет источников git/URL/реестра. Только локальные директории (`atomic-agent skill install <path>`).
- Стартового набора «заводских» скилов в бандле нет — формат открытый, пользователь и авторы плейбуков заполняют его сами.
