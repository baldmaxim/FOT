# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Архитектура

Монорепо с тремя частями:

- **fot-app/** — React 19 + Vite + TypeScript (фронтенд)
- **fot-server/** — Express + TypeScript (бэкенд, порт 3000)
- **supabase/** — локальный Supabase (PostgreSQL 17, миграции в `supabase/migrations/`)

Связь: фронтенд → REST API (`/api/...`) с JWT Bearer → бэкенд → Supabase (service role key, без RLS). Реалтайм через Socket.IO (чат, присутствие).

Внешняя интеграция: Sigur REST API (СКУД — система контроля доступа). Настройки подключения в `.env`.

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

# Supabase локальный
npx supabase start   # API :54321, DB :54322, Studio :54323
npx supabase stop
```

При изменении файлов в `fot-server/src/` — перезапустить сервер. Фронтенд перезапускать не нужно.

## Ключевые паттерны

- **Авторизация**: JWT + 2FA (TOTP). Роли через `position_type`: `worker`, `header`, `admin`, `super_admin`. Проверка в middleware (`auth.ts`), на фронте — `<ProtectedRoute>`.
- **Шифрование**: ФИО сотрудников хранятся зашифрованными (`full_name_encrypted`), расшифровка в `encryption.service.ts`.
- **Supabase**: используется service role key (RLS отключён), авторизация проверяется в middleware бэкенда.
- **API роуты**: все под префиксом `/api/` — auth, employees, admin, skud, sigur, structure, timesheet, audit, chat.
- **Фронтенд роуты**: по ролям — `worker` видит `/employee/*`, `header`+ видит `/dashboard`, `admin`+ видит `/tender`, `super_admin` видит `/skud-settings`, `/admin/*`.

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
