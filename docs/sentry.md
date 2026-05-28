# Sentry — мониторинг ошибок

Шпаргалка по работе с https://sentry.io для проекта FOT.

## Что подключено

- **fot-app** (React) — ловит исключения в компонентах (через `Sentry.ErrorBoundary`),
  unhandled promise rejection в браузере, серверные ошибки API (5xx) с тегами `endpoint`/`method`/`status`.
  Performance Tracing для pageload и навигации.
- **fot-server** (Express) — ловит ошибки HTTP-роутов через `Sentry.setupExpressErrorHandler`,
  ошибки Socket.IO (chat), `unhandledRejection` и `uncaughtException` процесса,
  ошибки фоновых сервисов `presence-polling` и `structure-scheduler`. Трейсинг HTTP-запросов и Express-роутов.
- **Session Replay (фронт)** — **отключён** (платная фича сверх free-тарифа). Если понадобится — вернуть `Sentry.replayIntegration({...})` в `integrations` и `replaysOnErrorSampleRate`/`replaysSessionSampleRate` в [fot-app/src/sentry.ts](../fot-app/src/sentry.ts). Маски по умолчанию: `maskAllText`/`maskAllInputs`/`blockAllMedia`.
- **Cron Monitoring (бэк)** — 9 фоновых джоб шлют чек-ины через [fot-server/src/utils/sentry-cron.ts](../fot-server/src/utils/sentry-cron.ts): `presence-polling`, `sigur-monitor`, `sigur-structure-sync`, `sigur-events-daily`, `skud-summary-reconcile`, `timesheet-reminder`, `patent-expiry-reminder`, `daily-tasks-reminder`, `mts-poller`. Если джоба молча перестала тикать (missed slot) — Sentry поднимет issue.
- **Uptime Monitoring** — настраивается в UI: Project `fot-server` → **Alerts → Uptime Monitors → Create Alert**, URL `https://<prod>/health` (handler в [app.ts:87](../fot-server/src/app.ts)), interval 1 min, регион EU.
- **Release Health / Deploy markers** — sourcemaps льются автоматом; для crash-free sessions и пометки регрессий нужен ручной `sentry-cli releases deploys ... new` после деплоя. См. [sentry-deploy-marker.md](sentry-deploy-marker.md).

## Первичная настройка (делается один раз)

### 1. Регистрация и проекты

1. Зарегистрироваться на https://sentry.io — Developer-тариф бесплатный (5K errors / 10K performance / 1 пользователь).
2. Создать **Organization** (например `fot-odintsov`).
3. Создать **два проекта**:
   - `fot-app` → платформа **React**
   - `fot-server` → платформа **Node.js / Express**
4. В каждом проекте → **Settings → Client Keys (DSN)** — скопировать DSN.

### 2. Auth-токен для загрузки sourcemaps

**Settings → Auth Tokens → Create New Token**, нужны права:
- `project:read`
- `project:releases`
- `org:read`

Токен показывается один раз — сохрани сразу.

### 3. .env файлы (правишь сам — Claude .env не трогает)

**`fot-server/.env`** (на проде в `/srv/sites/fot.su10.ru/fot-server/.env`):
```
SENTRY_DSN=https://<key>@o<orgId>.ingest.sentry.io/<backendProjectId>
SENTRY_AUTH_TOKEN=<токен из шага 2>
SENTRY_ORG=fot-odintsov
SENTRY_PROJECT=fot-server
```
`SENTRY_RELEASE` экспортируется при сборке (см. ниже).

**`fot-app/.env`** (на проде в `/srv/sites/fot.su10.ru/fot-app/.env`):
```
VITE_SENTRY_DSN=https://<key>@o<orgId>.ingest.sentry.io/<frontendProjectId>
SENTRY_AUTH_TOKEN=<тот же токен>
SENTRY_ORG=fot-odintsov
SENTRY_PROJECT=fot-app
```
`VITE_SENTRY_RELEASE` экспортируется при сборке (см. [DEPLOY.md](../DEPLOY.md)).

Локально для разработки DSN можно не задавать — Sentry просто молчит.

### 4. Интеграция с GitHub (опционально, рекомендую)

**Settings → Integrations → GitHub → Configure**: подключи репо. Sentry будет показывать
suspect commits в каждой ошибке и blame-аннотации к стек-трейсам.

---

## Эксплуатация: что и где смотреть

### Issues (ошибки)

Проект → **Issues**. Каждая ошибка — отдельный issue, группируется по типу исключения и точке стека.

**Жизненный цикл:**
- **New** — впервые увидели.
- **Reviewing/Ongoing** — открыта, продолжает приходить.
- **Resolve** — нажми, когда починил. Если ошибка вернётся — Sentry откроет её снова и пометит как **Regression**.
- **Archive** — спрятать (не критично, не чиним прямо сейчас).
- **Ignore** — больше никогда не показывать (для шумных, неустранимых).

**Что делать с новой ошибкой:**
1. Открыть issue → посмотреть **Stack Trace** (с sourcemaps будет читаемое имя файла:строка).
2. Вкладка **Breadcrumbs** — последовательность действий пользователя до ошибки (клики, навигация, HTTP-запросы).
3. Вкладка **Tags** — `release`, `user.id`, `endpoint`, `browser`, `os`. По любому из них можно отфильтровать поиск.
4. Раздел **Suspect Commits** (если подключён GitHub) — какие коммиты из релиза могли её внести.
5. Починить → закоммитить → задеплоить → нажать **Resolve** в issue.

### Performance

Проект → **Performance**. Список транзакций (HTTP-запросов и pageload) с p50/p75/p95.

Полезно: найти медленные endpoint, увидеть детальный waterfall (включая subqueries к Supabase, если их захватил OpenTelemetry).

### Releases

Проект → **Releases**. Каждый релиз = git commit hash (7 символов).
Sentry показывает:
- Какие issues появились впервые в этом релизе.
- Какие resolved-issues регрессировали.
- Сколько людей затронуто.

---

## Алёрты (уведомления о новых ошибках)

**Settings → Alerts → Create Alert**.

Базовые алёрты, которые стоит включить:

### 1. Issue Alert: новая ошибка
- **When**: A new issue is created
- **If**: (любые фильтры по environment/level)
- **Then**: Send email to `baldmaxim@gmail.com` (или Slack/Telegram через Webhook).

### 2. Metric Alert: всплеск ошибок
- **Metric**: Number of errors
- **Trigger**: > 50 за 5 минут (или > 5% от общего трафика).
- **Then**: тот же канал.

### Telegram-уведомления

Нативной интеграции нет. Варианты:
- **Webhook → бот**: создать Telegram-бота через @BotFather, развернуть простой relay
  (Cloudflare Worker / Vercel function), который принимает Sentry webhook и шлёт `sendMessage` через Bot API.
- **Email → Telegram**: завести forwarding через IFTTT/Make (медленнее, но без кода).

### Slack
Нативная интеграция: **Settings → Integrations → Slack → Install**, выбрать канал.

---

## Полезные фильтры в поиске Issues

```
is:unresolved level:error                       # все непочиненные ошибки
release:abc1234                                  # ошибки конкретного релиза
user.id:550e8400-e29b-41d4-a716-446655440000    # ошибки конкретного юзера
tags[endpoint]:/api/timesheet                    # ошибки конкретного endpoint
tags[service]:presence-polling                   # ошибки фонового сервиса
environment:production firstSeen:-24h            # новые за сутки на проде
```

---

## Квота и стоимость

Бесплатный Developer-тариф:
- **5,000 errors/мес**
- **10,000 performance events/мес**
- **1 GB attachments/мес**
- **1 пользователь**

Когда подходишь к лимиту, Sentry начинает дропать события. Что делать:
- **Settings → Stats** — посмотреть, какой проект жрёт квоту.
- Понизить `tracesSampleRate` с `0.1` до `0.05` или `0.02` в [fot-app/src/sentry.ts](../fot-app/src/sentry.ts) и [fot-server/src/instrument.ts](../fot-server/src/instrument.ts).
- Добавить шумные ошибки в `ignoreErrors` (фронт) или в **Settings → Inbound Filters** проекта.

Если упрёшься — следующий тариф **Team** $26/мес: 50K errors / 100K performance.

---

## Sourcemaps

Без sourcemaps стек-трейс выглядит как `assets/index-AbC123.js:1:8472` — почти бесполезно.
С ними — `EmployeeCardPage.tsx:42`.

**Загружаются автоматически при сборке** (см. [DEPLOY.md](../DEPLOY.md)):
- Frontend: `@sentry/vite-plugin` при `npm run build`, если задан `SENTRY_AUTH_TOKEN`. После загрузки `.map`-файлы удаляются из `dist/` — клиент их не видит.
- Backend: `npm run sentry:sourcemaps` после `npm run build`.

Проверка: после деплоя в Sentry → Releases → клик на релиз → вкладка **Artifacts** должна показывать список `.map`-файлов.

---

## Отладка интеграции

### Проверить, что Sentry подключился (фронт)
В DevTools браузера на загруженной странице:
```js
window.__SENTRY__   // должен быть объект, не undefined
```

### Триггернуть тестовую ошибку
**Фронт**: в любом компоненте временно вставить:
```tsx
<button onClick={() => { throw new Error('sentry-test-front') }}>test</button>
```
Кликнуть → через 5-10 секунд issue появится в Sentry.

**Бэк**: в любом контроллере добавить `throw new Error('sentry-test-back')` → дёрнуть endpoint → issue.

### События не приходят
1. Проверить, что DSN задан (`echo $VITE_SENTRY_DSN` / `echo $SENTRY_DSN`).
2. Открыть DevTools → Network → фильтр `sentry.io` — должны быть POST-запросы со статусом 200.
3. Не пользуется ли пользователь блокировщиком рекламы (uBlock блокирует sentry.io по умолчанию).
4. **Settings → Stats → Filtered events** — может Sentry дропает по своим фильтрам.

---

## PII и приватность

`sendDefaultPii: false` — Sentry **не собирает** автоматически IP, cookies, заголовки.
Что мы шлём явно:
- `user.id`, `user.email`, `username` (= role_code) — через `Sentry.setUser`.
- Тэги: endpoint, method, status, service.

Если для GDPR/конфиденциальности нужно убрать email — поправь:
- [fot-app/src/contexts/AuthContext.tsx](../fot-app/src/contexts/AuthContext.tsx) — убери `email` из `Sentry.setUser`.
- [fot-server/src/middleware/auth.ts](../fot-server/src/middleware/auth.ts) — то же самое.
