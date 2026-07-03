# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Архитектура

Репо с тремя подпроектами:

- **fot-app/** — React 19 + Vite + TypeScript (фронтенд)
- **fot-server/** — Express + TypeScript (бэкенд, порт 3001)
- **fot-data-api/** — Python/FastAPI, read-only API на порту 4001 для внешних интеграций (1С). Авторизация — Bearer-токены `fot_<prefix>_<secret>`, выдаются через админ-вкладку «API-доступ». Whitelist таблиц/полей в БД, slowapi rate-limit per-key. Детали в [API_1C.md](API_1C.md) и [fot-data-api/README.md](fot-data-api/README.md).

БД: **Yandex Managed PostgreSQL** (Phase 10 миграция с Supabase Cloud завершена). Связь: фронтенд → REST API (`/api/...`) с JWT Bearer → бэкенд → PG через `pg`-Pool (`fot-server/src/config/postgres.ts` — `query/queryOne/execute/withTransaction`). Аутентификация — собственная таблица `app_auth.users` + bcrypt (`local-auth.service.ts`), без Supabase Auth/PostgREST. Реалтайм через Socket.IO (чат, присутствие).

Внешняя интеграция: Sigur REST API (СКУД — система контроля доступа). Настройки подключения в `.env`.

Файловое хранилище: Cloudflare R2 (S3-совместимый SDK). Конфиг из `.env` или динамически из БД. Подписанные URL (1 час).

## Команды разработки

```bash
# Фронтенд (автоперезагрузка через Vite)
cd fot-app && npm run dev

# Бэкенд (автоперезагрузка через tsx watch)
cd fot-server && npx tsx watch src/index.ts

# Перезапуск бэкенда
npx kill-port 3001 && cd fot-server && npx tsx watch src/index.ts &

# Сборка
cd fot-app && npm run build      # TypeScript check + Vite build
cd fot-server && npm run build   # TypeScript compilation

# Линтинг
cd fot-app && npm run lint

# Тесты (бэкенд, vitest)
cd fot-server && npm run test

# Один тест-файл
cd fot-server && npx vitest run src/path/to/file.test.ts

# Превью прод-сборки фронта
cd fot-app && npm run preview

# Загрузка sourcemap бэка в Sentry (требует SENTRY_AUTH_TOKEN)
cd fot-server && npm run sentry:sourcemaps

# Аудит защиты роутов (бэкенд)
cd fot-server && npm run audit:routes

# Генерация PWA-иконок (фронтенд)
cd fot-app && npm run icons:generate

# Data API (отдельный подпроект, Python)
cd fot-data-api && uvicorn app.main:app --reload --port 4001
```

При изменении файлов в `fot-server/src/` — перезапустить сервер. Фронтенд перезапускать не нужно.

## Ключевые паттерны

- **Авторизация**: JWT + 2FA (TOTP). Роли через `position_type` + `system_role_id` (таблица `system_roles`). Проверка в middleware (`auth.ts`), на фронте — `<ProtectedRoute>`. Иерархия ролей через `level` из `system_roles`.
- **Скоуп админа**: `system_admin` видит все компании; `admin` (компанийный) — только корни Sigur, привязанные через таблицу `user_company_access` (миграция 083). Резолвинг скоупа в `data-scope.service.ts` + функция `public.get_descendant_department_ids($1::uuid[])`.
- **ФИО сотрудников**: хранятся plain-text (`full_name`, `last_name`, `first_name`, `middle_name`). `encryption.service.ts` используется только для TOTP и чата, не для ФИО.
- **БД-runtime**: прямой `pg.Pool` через `config/postgres.ts` (`query/queryOne/execute/withTransaction`). Supabase SDK удалён из package.json в Phase 10E (см. `docs/yandex-postgres-migration/`). RLS не используется — авторизация проверяется в middleware. Аутентификация через `app_auth.users` + bcrypt (`local-auth.service.ts`).
- **API роуты**: все под префиксом `/api/` — auth, employees, admin, skud, sigur, structure, timesheet, audit, chat, push, leave-requests, documents, payslips, payments, production-calendar, timesheet-approvals, schedules, roles, salary-raise, settings, notifications, work-categories, official-memos, admin-data-api, correction-approvals, patent-receipts, daily-tasks, direct-reports.
- **Фронтенд роуты**: по ролям — `worker` видит `/employee/*`, `header`+ видит `/dashboard`, `admin` видит `/employees`, `/skud-settings`, `/admin/*`.

## Структура бэкенда

- **Контроллеры** (`fot-server/src/controllers/`): декомпозированы по доменам — `admin-*`, `auth-*`, `employee-*`, `sigur-*`, `skud-*`, `timesheet-*`.
- **Сервисы** (`fot-server/src/services/`): `sigur-sync-*` (employees, events, structure, shared), `skud-*` (backfill, dashboard, discipline, import, presence, shared), `employee-mapper.service.ts` (кэш структуры + маппинг полей).
- **Конфиг** (`fot-server/src/config/`): `postgres.ts` (pg-Pool + helpers `query/queryOne/execute/withTransaction`), `env.ts` (включая `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_SSL`, `DATABASE_SSL_CA_PATH`), `features.ts` (`LOGIN_2FA_ENABLED`, `CRITICAL_2FA_ENABLED`, `IS_PRODUCTION`), `access-control.ts`, `supabase-instrumentation.ts` (legacy-имя — это семафор `withSupabaseSlot` для presence-polling и тяжёлых RPC; переименование запланировано отдельно).
- **Типы Express**: `fot-server/src/types/express.d.ts` — расширение `req.user` с типизацией.
- **Middleware**: `auth.ts`, `rateLimit.ts` (`apiLimiter` 500/15мин, `authLimiter` 10/15мин, `twoFactorLimiter` 5/5мин, `importLimiter` 5/1ч; в dev лимиты выше), `cacheResponse.ts` — LRU-кеш JSON-ответов (max 200, настраиваемый TTL/key), `noStore` (отключение кэша на чувствительных эндпоинтах), `skipCacheForToday` (инвалидация дневного кэша), `serverTiming` (Server-Timing header).
- **Загрузка файлов**: multer в `memoryStorage` (используется в `admin.routes.ts`, `employees.routes.ts`).
- **Утилитные скрипты** (`fot-server/scripts/`): миграционные/back-fill таски (backfill-dedup-hash, backfill-employee-ids и т.п.), запуск через `npx tsx`.

## Фоновые сервисы

Запускаются в `src/index.ts` при старте сервера:
- **presence-polling**: incremental polling СКУД-событий по `lastId` (cursor-based seek), adaptive interval — 60 сек при активности, 30 сек idle после 5 пустых тиков подряд. Дифференцированные TTL кэшей (employees 5 мин, departments 60 мин, access points/rules 1–4 ч). Дедупликация по UNIQUE `(dedup_hash, event_date)`. См. коммит 895a196.
- **sigur-monitor**: непрерывный мониторинг изменений структуры Sigur.
- **sigur-structure-scheduler**: синхронизация отделов/должностей/сотрудников из Sigur (по умолчанию каждые 2 ч), задержка 30 сек при старте.
- **sigur-events-daily-scheduler**: ежедневная подгрузка СКУД-событий.
- **timesheet-reminder**: напоминания о незакрытых табелях.
- **patent-expiry-reminder**: уведомления об истечении патентов.
- **daily-tasks-reminder**: напоминания о суточных задачах. Тик каждые 5 мин, активная отправка 16:50–17:00 МСК.
- **ai-receipt-recognition**: возобновление очереди распознавания чеков при старте.
- **mts-business-cdr-daily-scheduler**: ежедневное автообновление детализации звонков МТС Бизнес через синхронный Bills API (без email/IMAP), раз в сутки после заданного часа МСК, с catchup-окном; per-аккаунт rate-limit гейт (60/300 запросов в мин).

## Socket.IO

Синглтон: `src/socket/io-instance.ts` (`setIo` / `getIo`).

Обработчик чата (`src/socket/chatHandler.ts`):
- Авторизация по JWT при handshake
- Комнаты: `user:${userId}` (личные уведомления), `conv:${conversationId}` (сообщения)
- События: `join_conversation`, `leave_conversation`, `send_message`, `typing`, `mark_read`
- При отправке сообщения: сохранение в БД → emit в комнату → Web Push → уведомление в БД

## Структура фронтенда

- **API клиент** (`fot-app/src/api/client.ts`): кастомный `apiClient` с методами `get/post/put/patch/delete`, авто-подстановка Bearer токена, `ApiError` класс. Base URL: `VITE_API_URL` или `http://localhost:3001/api`.
- **Стейт**: React Context для UI (Auth, Toast, Chat) + TanStack React Query для серверных данных (`staleTime: 30s`, `gcTime: 5min`, `retry: 1`).
- **Стили**: CSS Modules + CSS Variables (тёмная/светлая тема через `data-theme`). Дизайн-токены в `src/index.css`.
- **Код-сплиттинг**: `vite.config.ts` — `manualChunks` по роутам и вендорам.
- **Провайдеры в `App.tsx`** (снаружи внутрь): `Sentry.ErrorBoundary` → `QueryClientProvider` → `BrowserRouter` → `AuthProvider` → `ToastProvider` → `ChatProvider` → роуты + `ChatPanelMount`.

## Тесты

- Расположение: `fot-server/src/**/*.test.ts` (контроллеры, сервисы, integration). На фронте тестов нет.
- Ранер: vitest. Всё: `npm run test`. Один файл: `npx vitest run src/.../*.test.ts`.
- Setup: `fot-server/src/__tests__/setup.ts` — мокает `@sentry/node`, ставит `TZ=Europe/Moscow`, заполняет env по умолчанию.

## Observability

- **Sentry бэк** (`fot-server/src/instrument.ts`) — импорт первой строкой `index.ts`, profiling отключён (платная фича сверх free-тарифа), `tracesSampleRate` 0.1. Глобальные `unhandledRejection`/`uncaughtException` ловят в Sentry, процесс не падает (PM2 решит сам).
- **Sentry фронт** — `Sentry.ErrorBoundary` оборачивает приложение, `api/client.ts` шлёт 5xx в Sentry. Ошибки stale-чанков игнорируются (`ignoreErrors`).
- **Логирование** — `console.log` / `console.error`, без pino/winston.
- **Sentry MCP** доступен в Claude Code: стеки и события читать через `mcp__sentry__*`, не просить пользователя копировать.

## Валидация

- **Zod** используется только на бэкенде (v3.x). На фронте zod не подключён — валидация выполняется в API-слое сервера.

## Общие правила

- TypeScript для всего кода, строгая типизация, избегать `any`
- Функциональные компоненты (FC) с React hooks
- Arrow functions, деструктуризация пропсов, `export const`
- Один компонент на файл, максимум 500 строк — иначе дели на части
- MVP: минимально работающая версия, без фич "на будущее"
- **Модалки**: закрытие по клику на overlay — только через хук [`useOverlayDismiss`](fot-app/src/hooks/useOverlayDismiss.ts). Модалка НЕ должна закрываться, если ЛКМ зажата внутри (выделение текста, drag-to-select) и отпущена за границами. Простой `onClick={onClose}` на overlay запрещён.
- **Ответы на русском**: все ответы и объяснения пиши на русском языке. Код-примеры могут быть на английском (if, function, const и т.д.), но описание, комментарии и коммиты — только русский.

## Именование

- Компоненты: `PascalCase` (`UserCard.tsx`)
- Хуки: `camelCase` с `use` (`useAuth.ts`)
- Утилиты: `camelCase` (`formatDate.ts`)
- Типы/Интерфейсы: `PascalCase`, интерфейсы с `I` (`IUser`)
- Константы: `UPPER_SNAKE_CASE`

## Пример компонента

```tsx
import { FC } from 'react';

interface IButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export const Button: FC<IButtonProps> = ({ label, onClick, disabled = false }) => {
  return (
    <button onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
};
```

## Запрещено

- `var` (только `const` и `let`)
- `@ts-ignore`
- Inline стили (кроме динамических значений)
- Мутировать состояние напрямую

## Адаптивность (обязательно)

Все UI компоненты адаптированы под:
- **iPhone 15 Pro Max** (430 × 932 px)
- **iPhone 12** (390 × 844 px)
- **iPad** (768 × 1024 px и больше)

CSS media queries для всех целевых устройств.

### Android-смартфоны

- Брейкпоинты: 360px (Galaxy A0x/старые), 360–412px (основной Android-диапазон).
- Высоты: только `100dvh`/`svh`, не `100vh` (адрес-бар Chrome съедает vh).
- `env(safe-area-inset-*)` + `viewport-fit=cover` для шторок/жестов.
- Тап-цели ≥ 44×44px (рекоменд. 48px Material).
- `font-size` инпутов ≥ 16px (нет авто-зума и на Android-Chrome).
- Нет горизонтального скролла на 360px; `overflow-wrap` вместо `word-break`.
- Fixed-панели/модалки: высота через `dvh`, ресайз — `window.visualViewport`.
- Проверять на Pixel (412px) и Galaxy A (360px) в DevTools.

## Документация

- `DEPLOY.md` — инструкции по деплою на прод (PM2, nginx, Ubuntu)
- `API_1C.md` — публичный read-only API для 1С (Bearer-токены, whitelist таблиц/полей)
- `docs/` — 2FA, шифрование, миграции БД, Sigur API, бэклог
- `docs/migrations/` — SQL-миграции (нумерованы 001–...), применяются вручную через `psql` на сервере (авто-миграций нет)
- `scripts/` — `deploy-frontend.sh`, `deploy-backend.sh`, `deploy-both.sh` (атомарные деплои на прод; билд локально + tar-pipe)

## КРАТКОСТЬ

- Отвечай максимально сжато. Без пояснений и предисловий.
- Код — только рабочие фрагменты в блоках, без текста.
- Изменения — *минимальный diff/patch* или *конкретные вставки*.
- Не перечисляй «что было сделано», если не попросили.
- Текст — не более 5 пунктов, каждый ≤ 12 слов.

## .env

- НИКОГДА не изменять `.env` файлы
- Ключи и URL добавляет только пользователь вручную

## Git

- Коммиты на русском, кратко (1-2 предложения)
- Без приписок "Generated with Claude Code" и "Co-Authored-By"
- Push только в `personal` (origin — чужой/устаревший форк)
- Из SSH/Claude-сессии при ошибке `wincredman` сразу: `GCM_CREDENTIAL_STORE=dpapi git push personal main` (bash) или `$env:GCM_CREDENTIAL_STORE='dpapi'; git push personal main` (PowerShell). Не перебирать альтернативы.
