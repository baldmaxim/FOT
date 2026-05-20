# Sentry deploy markers — пометка релиза как «выехавшего в прод»

Sourcemaps и release-тег уже подгружаются автоматически при сборке (см. [sentry.md](sentry.md)).
Не хватает только одного шага — **отметить релиз как развёрнутый в production**, чтобы Sentry мог:

- Считать crash-free sessions / crash-free users по релизу.
- Помечать issues как «появилось после деплоя X» или «регрессировало в релизе X».
- Показывать на графике вертикальную метку deploy в момент времени.

## Команда после деплоя

После каждого ручного деплоя на прод (бэк или фронт) выполнить:

```bash
# Бэкенд
SENTRY_AUTH_TOKEN=<token> \
SENTRY_ORG=odintsovorg \
SENTRY_PROJECT=fot-server \
npx @sentry/cli releases deploys "<git-sha>" new -e production

# Фронтенд
SENTRY_AUTH_TOKEN=<token> \
SENTRY_ORG=odintsovorg \
SENTRY_PROJECT=fot-app \
npx @sentry/cli releases deploys "<git-sha>" new -e production
```

Где `<git-sha>` — тот же короткий git SHA, что улетел как `SENTRY_RELEASE` (бэк) и `VITE_SENTRY_RELEASE` (фронт) при сборке. Обычно это `git rev-parse --short HEAD` коммита, который выехал.

`@sentry/cli` уже стоит в `fot-server/package.json` (devDependency), поэтому `npx` его подхватит.

## Переменные окружения

| Переменная | Значение |
|---|---|
| `SENTRY_AUTH_TOKEN` | Тот же, что используется для `sentry:sourcemaps` (Settings → Auth Tokens, scopes `project:releases`) |
| `SENTRY_ORG` | `odintsovorg` (из MCP whoami) |
| `SENTRY_PROJECT` | `fot-server` для бэка, `fot-app` для фронта |

Токен в `.env` не дублировать — экспортировать в shell сессии деплоя.

## Опционально: финализировать релиз

Если хочется явно «закрыть» окно релиза (после стабилизации):

```bash
npx @sentry/cli releases finalize "<git-sha>"
```

Без этого Sentry сам пометит финализацию через ~24 часа неактивности.

## Проверка

После выполнения команды:

1. **Sentry → Releases** → клик на нужный релиз → видна метка **Deployed to production** с timestamp.
2. Через ~1 час использования прод-юзерами у релиза появятся **Crash Free Sessions %** и **Crash Free Users %**.
3. Если в этом релизе всплыла регрессия — соответствующий issue будет помечен как **regressed in release X**.

## Почему не вшито в `scripts/deploy-*.sh`

По договорённости с пользователем деплой остаётся ручным; `scripts/deploy-*.sh` не модифицируется автоматически. Если захочется автоматизировать — это четыре строки в конце своего деплой-пайплайна (по две на бэк и фронт), переменные те же.
