# MCP-доступ к прод-БД (read-only)

Claude Code и Codex CLI ходят в `FOT_Prod` под ролью `mcp_readonly` через
`@modelcontextprotocol/server-postgres`. Пароль **не хранится в конфигах и не передаётся
аргументом командной строки** — он берётся из переменной окружения и уходит серверу через
`PGPASSWORD`.

## Как это устроено

```
Claude Code / Codex → scripts/mcp-yandex-pg.ps1 → node tools/mcp-postgres/…/dist/index.js → mcp_readonly
                        ↑ FOT_MCP_PGURL (без пароля)
                        ↑ FOT_MCP_PGPASSWORD → PGPASSWORD
```

- `tools/mcp-postgres/` — зафиксированная версия сервера (`0.6.2`), ставится один раз;
  `npx -y` не используется, чтобы не тянуть пакет из сети при каждом запуске и не отдавать
  окружение с паролем install-скриптам.
- `scripts/mcp-yandex-pg.ps1` — общий launcher для обоих клиентов. Проверяет URL (схема,
  пользователь, хост, порт, база, `sslmode=verify-full`, канонический путь к CA), выставляет
  `PGPASSWORD` и запускает сервер. В stdout не пишет ничего — там JSON-RPC.

## Первичная настройка

1. Установить сервер (окружение чистим, чтобы секреты не попали в npm):

   ```powershell
   $env:YANDEX_PG_URL      = $null
   $env:FOT_MCP_PGPASSWORD = $null
   $env:PGPASSWORD         = $null
   npm ci --ignore-scripts --prefix tools/mcp-postgres
   ```

   Если `package-lock.json` ещё не создан:
   `npm install --package-lock-only --ignore-scripts --prefix tools/mcp-postgres`.

2. Завести две пользовательские переменные окружения (разово):

   ```
   FOT_MCP_PGURL      = postgres://mcp_readonly@<host>.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=<репозиторий>/.migration/yandex-ca.pem
   FOT_MCP_PGPASSWORD = <пароль роли mcp_readonly>
   ```

   Чтобы пароль не осел в истории PowerShell:

   ```powershell
   $secure = Read-Host 'Пароль mcp_readonly' -AsSecureString
   $plain  = [System.Net.NetworkCredential]::new('', $secure).Password
   try { [Environment]::SetEnvironmentVariable('FOT_MCP_PGPASSWORD', $plain, 'User') }
   finally { $plain = $null; $secure.Dispose() }
   ```

3. Клиенты настроены на launcher: `.mcp.json` (Claude Code, файл в `.gitignore`) и
   `~/.codex/config.toml` (Codex — плюс `env_vars = ["FOT_MCP_PGURL", "FOT_MCP_PGPASSWORD"]`).

## Правила

- Пароль в `.mcp.json`, `config.toml` и argv **не возвращаем** — ни временно, ни «для отладки».
- URL в `FOT_MCP_PGURL` — всегда без пароля; launcher откажется стартовать, если пароль там есть.
- Значения переменных не печатаем в логи, не пересылаем в чаты, не передаём аргументами поиска.
- При смене пароля роли достаточно обновить `FOT_MCP_PGPASSWORD` — конфиги не трогаются.

## Известные ограничения

- `FOT_MCP_PGPASSWORD` лежит в `HKCU\Environment` и доступен процессам того же пользователя.
  Это защищает от утечки в конфиги, git и список процессов, но не от локальных процессов.
- `npm audit` показывает high-уязвимость `@modelcontextprotocol/sdk <1.24.0` (DNS rebinding
  в HTTP-транспорте). Мы используем stdio-транспорт, вектор неприменим; апстрим-пакет
  архивирован, фикса нет.
- Права роли `mcp_readonly` этой настройкой не меняются — она остаётся широким read-only
  доступом к прод-данным. Ужесточение прав (безопасные views, таймауты) — отдельная задача.
