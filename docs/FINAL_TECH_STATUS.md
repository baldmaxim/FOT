# Техническое состояние проекта ФОТ

Дата фиксации: 2026-03-25

---

## Архитектура

Монорепо из трёх частей:

| Модуль | Стек | Назначение |
|--------|------|------------|
| **fot-app** | React 19, Vite, TypeScript | SPA-фронтенд |
| **fot-server** | Express, TypeScript | REST API (порт 3001) |
| **supabase** | PostgreSQL 17, локальный Supabase | БД, миграции |

Связь: фронтенд → REST `/api/*` с JWT Bearer → бэкенд → Supabase (service role key, RLS отключён).
Реалтайм: Socket.IO (чат, присутствие).
Внешняя интеграция: Sigur REST API (СКУД).

---

## Backend

- **9 route-файлов**, ~73 эндпоинта
- **22 контроллера** (декомпозиция по модулям)
- **20 сервисов**

### Ключевые модули

| Модуль | Файлы | Статус |
|--------|-------|--------|
| Auth | auth.controller, auth-2fa.controller | Стабилен |
| Admin | admin.controller, admin-users, admin-2fa, admin-org | Стабилен |
| Employees | employees.controller, employee-lifecycle, employee-import, employee-enrich | Стабилен |
| Structure | structure.controller | Стабилен |
| Timesheet | timesheet.controller, timesheet-export | Стабилен |
| SKUD | skud.controller, skud-write, skud-shared, skud-dashboard, skud-discipline, skud-presence | Стабилен |
| Sigur | sigur.controller, sigur-sync, sigur-admin, sigur-filter + 6 сервисов | Стабилен, требует улучшения наблюдаемости |
| Audit | audit.controller, audit.service | MVP |
| Chat | chat.controller, chat.service | Заморожен |

---

## Frontend

React 19 + Vite + TypeScript.

### Структура компонентов

`fot-app/src/components/`: auth, dashboard, discipline, employees, layout, skud, admin, timesheet, ui.

`fot-app/src/pages/`: auth, employee (личный кабинет), employees, profile, skud, admin, timesheet.

---

## Модель ролей

```
worker (1) < header (2) < admin (3)
```

| Роль | Доступ |
|------|--------|
| worker | `/employee/*` — личный кабинет |
| header | + `/dashboard`, `/timesheet`, `/admin/structure` |
| admin | + `/employees`, `/skud-raw`, `/skud-db`, `/discipline`, `/skud-settings`, `/admin/users`, `/admin/organizations`, `/admin/audit` |

---

## Auth / 2FA

- JWT Bearer token, проверка в middleware `authenticate`
- 2FA: TOTP (otpauth) + recovery codes
- **Два независимых feature flag** (`fot-server/src/config/features.ts`):
  - `LOGIN_2FA_ENABLED` — 2FA-проверка при логине (промежуточный токен → verify-2fa)
  - `CRITICAL_2FA_ENABLED` — 2FA для критических мутаций (импорт, удаление, синхронизация)
- По умолчанию оба `false` (dev-режим). Для production: установить `=true` в env.

## Rate Limiting

- `express-rate-limit` с автоматическим переключением dev/production через `NODE_ENV`
- Production лимиты: auth=10/15min, 2FA=5/5min, API=200/15min, import=5/hour
- Development лимиты: auth=50/15min, 2FA=20/5min, API=500/15min, import=10/hour
- Применено: login, register, forgot-password, reset-password, verify-2fa, recovery

---

## Audit

- **MVP**: логирование действий в таблицу `audit_logs`
- 60 типов действий (auth, admin, employees, structure, timesheet, skud, sigur, salary)
- Ошибки записи в лог не блокируют основную операцию
- Нет механизма отключения отдельных типов
- Эндпоинты: `GET /api/audit/run`, `GET /api/audit/check/:checkType` (admin+)

---

## Employees / Structure

- CRUD с шифрованием ФИО (AES-256-GCM, `encryption.service.ts`)
- Импорт/обогащение из Excel
- Жизненный цикл: archive, restore, fire, rehire, move-department
- Пагинация списка сотрудников
- Дерево организаций → отделы (с иерархией)

---

## SKUD / Sigur

- Синхронизация: организации, отделы, должности, сотрудники, события
- Whitelist по отделам (`skud_sync_department_filter`)
- Дедупликация событий по hash
- Пагинация: `fetchAllPaginated` (offset/limit, pageSize=3000) — автоматически загружает все страницы
- Matching: приоритет sigur_employee_id, fallback по ФИО+организация
- Нормализация имён: `normalizePersonName` (lowercase + trim + collapse whitespace)
- Диагностика: matchedBySigurId, matchedByName, paginatedDays, noNameSamples
- Пересчёт daily summary через RPC `batch_recalculate_skud_daily_summary`

---

## Заморожено

| Модуль | Причина | Состояние кода |
|--------|---------|----------------|
| Chat | Бизнес-решение, приоритет на СКУД | 6 эндпоинтов реализованы, Socket.IO настроен, не развивается |

---

## Техдолг

| Категория | Описание | Риск |
|-----------|----------|------|
| Тесты | Базовые smoke-тесты (8 шт, vitest+supertest). E2E и integration отсутствуют | Средний |
| 2FA | Управляется feature flags. Для production: `LOGIN_2FA_ENABLED=true`, `CRITICAL_2FA_ENABLED=true` | Высокий для production |
| Encryption key rotation | Не реализован | Средний |
| Bundle size | exceljs — 937 KB (gzip 271 KB) | Низкий |

---

## Миграции БД

```
supabase/migrations/
├── 20260101000000_init.sql
├── 20260311_create_chat_tables.sql
├── 20260323100000_add_employee_enrich_columns.sql
└── 20260323_fix_recalculate_skud_daily_summary.sql
```
