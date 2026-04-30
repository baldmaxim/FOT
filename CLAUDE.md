# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Архитектура

Монорепо с двумя частями:

- **fot-app/** — React 19 + Vite + TypeScript (фронтенд)
- **fot-server/** — Express + TypeScript (бэкенд, порт 3001)

БД: Supabase Cloud (PostgreSQL). Связь: фронтенд → REST API (`/api/...`) с JWT Bearer → бэкенд → Supabase Cloud (service role key, без RLS). Реалтайм через Socket.IO (чат, присутствие).

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
```

При изменении файлов в `fot-server/src/` — перезапустить сервер. Фронтенд перезапускать не нужно.

## Ключевые паттерны

- **Авторизация**: JWT + 2FA (TOTP). Роли через `position_type` + `system_role_id` (таблица `system_roles`). Проверка в middleware (`auth.ts`), на фронте — `<ProtectedRoute>`. Иерархия ролей через `level` из `system_roles`.
- **ФИО сотрудников**: хранятся plain-text (`full_name`, `last_name`, `first_name`, `middle_name`). `encryption.service.ts` используется только для TOTP и чата, не для ФИО.
- **Supabase**: используется service role key (RLS отключён), авторизация проверяется в middleware бэкенда. Фронтенд к PostgREST напрямую не обращается.
- **API роуты**: все под префиксом `/api/` — auth, employees, admin, skud, sigur, structure, timesheet, audit, chat, push, leave-requests, documents, payslips, payments, production-calendar, timesheet-approvals, schedules, roles, salary-raise, settings, notifications, work-categories, official-memos, admin-data-api, correction-approval, patent-receipts.
- **Фронтенд роуты**: по ролям — `worker` видит `/employee/*`, `header`+ видит `/dashboard`, `admin`+ видит `/employees`, `super_admin` видит `/skud-settings`, `/admin/*`.

## Структура бэкенда

- **Контроллеры** (`fot-server/src/controllers/`): декомпозированы по доменам — `admin-*`, `auth-*`, `employee-*`, `sigur-*`, `skud-*`, `timesheet-*`.
- **Сервисы** (`fot-server/src/services/`): `sigur-sync-*` (employees, events, structure, shared), `skud-*` (backfill, dashboard, discipline, import, presence, shared), `employee-mapper.service.ts` (кэш структуры + маппинг полей).
- **Конфиг** (`fot-server/src/config/`): `database.ts` (Supabase service-role клиент), `env.ts`, `features.ts` (`LOGIN_2FA_ENABLED`, `CRITICAL_2FA_ENABLED`, `IS_PRODUCTION`), `access-control.ts`.
- **Типы Express**: `fot-server/src/types/express.d.ts` — расширение `req.user` с типизацией.
- **Middleware**: `auth.ts`, `rateLimit.ts` (`apiLimiter` 500/15мин, `authLimiter` 10/15мин, `twoFactorLimiter` 5/5мин, `importLimiter` 5/1ч; в dev лимиты выше), `cacheResponse.ts` — LRU-кеш JSON-ответов (max 200, настраиваемый TTL/key).
- **Загрузка файлов**: multer в `memoryStorage` (используется в `admin.routes.ts`, `employees.routes.ts`).
- **Утилитные скрипты** (`fot-server/scripts/`): миграционные/back-fill таски (backfill-dedup-hash, backfill-employee-ids и т.п.), запуск через `npx tsx`.

## Фоновые сервисы

Запускаются в `src/index.ts` при старте сервера (lines 36–44):
- **presence-polling**: опрос СКУД-событий каждые 60 сек, кэш сотрудников с TTL 10 мин, дедупликация, lock для синхронизации.
- **sigur-monitor**: непрерывный мониторинг изменений структуры Sigur.
- **sigur-structure-scheduler**: синхронизация отделов/должностей/сотрудников из Sigur каждый час, задержка 30 сек при старте.
- **sigur-events-daily-scheduler**: ежедневная подгрузка СКУД-событий.
- **timesheet-reminder**: напоминания о незакрытых табелях.
- **patent-expiry-reminder**: уведомления об истечении патентов.
- **ai-receipt-recognition**: возобновление очереди распознавания чеков при старте.

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

- **Sentry бэк** (`fot-server/src/instrument.ts`) — импорт первой строкой `index.ts`, profiling включён, `tracesSampleRate` 0.1. Глобальные `unhandledRejection`/`uncaughtException` ловят в Sentry, процесс не падает (PM2 решит сам).
- **Sentry фронт** — `Sentry.ErrorBoundary` оборачивает приложение, `api/client.ts` шлёт 5xx в Sentry. Ошибки stale-чанков игнорируются (`ignoreErrors`).
- **Логирование** — `console.log` / `console.error`, без pino/winston.
- **Sentry MCP** доступен в Claude Code: стеки и события читать через `mcp__sentry__*`, не просить пользователя копировать.

## Валидация

- **Zod** используется и на фронте (v4.x), и на бэкенде (v3.x) — API разный, учитывать при написании схем.

## Общие правила

- TypeScript для всего кода, строгая типизация, избегать `any`
- Функциональные компоненты (FC) с React hooks
- Arrow functions, деструктуризация пропсов, `export const`
- Один компонент на файл, максимум 500 строк — иначе дели на части
- MVP: минимально работающая версия, без фич "на будущее"

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

## Документация

- `DEPLOY.md` — инструкции по деплою на прод (PM2, nginx, Ubuntu)
- `docs/` — 2FA, шифрование, миграции БД, Sigur API, бэклог
- `docs/migrations/` — SQL-миграции (нумерованы 001–...), применяются вручную через `psql` на сервере (авто-миграций нет)
- `scripts/deploy-frontend.sh` — атомарный деплой фронта (билд локально + tar-pipe в `/var/www/fot/fot-app/dist`)

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
