# codex.md

This file provides guidance to Codex when working with code in this repository.

Поддерживать файл в актуальном состоянии и дополнять по мере проектирования проекта.

## Архитектура

Монорепо с двумя частями:

- **fot-app/** — React 19 + Vite + TypeScript (фронтенд)
- **fot-server/** — Express + TypeScript (бэкенд, порт 3000)

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
npx kill-port 3000 && cd fot-server && npx tsx watch src/index.ts &

# Сборка
cd fot-app && npm run build      # TypeScript check + Vite build
cd fot-server && npm run build   # TypeScript compilation

# Линтинг
cd fot-app && npm run lint

# Тесты (бэкенд, vitest)
cd fot-server && npm run test
```

При изменении файлов в `fot-server/src/` — перезапустить сервер. Фронтенд перезапускать не нужно.

## Ключевые паттерны

- **Авторизация**: JWT + 2FA (TOTP). Роли через `position_type` + `system_role_id` (таблица `system_roles`). Проверка в middleware (`auth.ts`), на фронте — `<ProtectedRoute>`. Иерархия ролей через `level` из `system_roles`.
- **ФИО сотрудников**: хранятся plain-text (`full_name`, `last_name`, `first_name`, `middle_name`). `encryption.service.ts` используется только для TOTP и чата, не для ФИО.
- **Supabase**: используется service role key (RLS отключён), авторизация проверяется в middleware бэкенда. Фронтенд к PostgREST напрямую не обращается.
- **API роуты**: все под префиксом `/api/` — auth, employees, admin, skud, sigur, structure, timesheet, audit, chat, push, leave-requests, documents, payslips, payments, production-calendar, timesheet-approvals, schedules, roles, salary-raise, settings, notifications.
- **Фронтенд роуты**: по ролям — `worker` видит `/employee/*`, `header`+ видит `/dashboard`, `admin`+ видит `/employees`, `super_admin` видит `/skud-settings`, `/admin/*`.

## Структура бэкенда

- **Контроллеры** (`fot-server/src/controllers/`): декомпозированы по доменам — `admin-*`, `auth-*`, `employee-*`, `sigur-*`, `skud-*`, `timesheet-*`.
- **Сервисы** (`fot-server/src/services/`): `sigur-sync-*` (employees, events, structure, shared), `skud-*` (backfill, dashboard, discipline, import, presence, shared), `employee-mapper.service.ts` (кэш структуры + маппинг полей).
- **Feature flags**: `fot-server/src/config/features.ts` — `LOGIN_2FA_ENABLED`, `CRITICAL_2FA_ENABLED`, `IS_PRODUCTION`.
- **Типы Express**: `fot-server/src/types/express.d.ts` — расширение `req.user` с типизацией.
- **Rate limiting** (`fot-server/src/middleware/rateLimit.ts`): разные лимитеры — `apiLimiter` (500/15мин), `authLimiter` (10/15мин), `twoFactorLimiter` (5/5мин), `importLimiter` (5/1ч). В dev-режиме лимиты выше.

## Фоновые сервисы

Запускаются в `src/index.ts` при старте сервера:
- **Presence polling** (`presence-polling.service.ts`): опрос СКУД-событий каждые 60 сек, кэш сотрудников с TTL 10 мин, дедупликация, lock для синхронизации.
- **Structure sync** (`sigur-structure-scheduler.service.ts`): синхронизация отделов/должностей/сотрудников из Sigur каждый час, задержка 30 сек при старте.
- **Sigur background**: фоновые задачи Sigur всегда явно выбирают канал подключения и логируют фактически использованный (`external` при наличии, `internal` только как fallback).

## Socket.IO

Синглтон: `src/socket/io-instance.ts` (`setIo` / `getIo`).

Обработчик чата (`src/socket/chatHandler.ts`):
- Авторизация по JWT при handshake
- Комнаты: `user:${userId}` (личные уведомления), `conv:${conversationId}` (сообщения)
- События: `join_conversation`, `leave_conversation`, `send_message`, `typing`, `mark_read`
- При отправке сообщения: сохранение в БД → emit в комнату → Web Push → уведомление в БД

## Структура фронтенда

- **API клиент** (`fot-app/src/api/client.ts`): кастомный `apiClient` с методами `get/post/put/patch/delete`, авто-подстановка Bearer токена, `ApiError` класс. Base URL: `VITE_API_URL` или `http://localhost:3000/api`.
- **Стейт**: React Context для UI (Auth, Toast, Chat) + TanStack React Query для серверных данных (`staleTime: 30s`, `gcTime: 5min`, `retry: 1`).
- **Стили**: CSS Modules + CSS Variables (тёмная/светлая тема через `data-theme`). Дизайн-токены в `src/index.css`.
- **Темы**: новые страницы и состояния сразу оформлять для light/dark theme через токены `src/index.css`, без хардкодных светлых цветов.
- **Код-сплиттинг**: `vite.config.ts` — `manualChunks` по роутам и вендорам.

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
