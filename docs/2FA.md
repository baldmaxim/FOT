# Двухфакторная аутентификация (2FA)

## Архитектура

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ПРОЦЕСС ВХОДА                                │
├─────────────────────────────────────────────────────────────────────┤
│  1. Пользователь вводит email + пароль                              │
│                          ↓                                          │
│  2. Supabase Auth проверяет credentials                             │
│                          ↓                                          │
│  3. Если 2FA включена → выдаётся временный JWT (two_factor_verified │
│     = false)                                                        │
│                          ↓                                          │
│  4. Пользователь вводит 6-значный TOTP код                          │
│                          ↓                                          │
│  5. Код проверяется → выдаётся полный JWT (two_factor_verified      │
│     = true)                                                         │
└─────────────────────────────────────────────────────────────────────┘
```

## Алгоритм TOTP

**TOTP (Time-based One-Time Password)** — стандарт RFC 6238

| Параметр | Значение |
|----------|----------|
| Алгоритм | SHA-1 |
| Длина кода | 6 цифр |
| Период | 30 секунд |
| Окно проверки | ±1 период (для синхронизации времени) |
| Размер секрета | 20 байт (160 бит) |

Реализация: `fot-server/src/services/totp.service.ts`

## Шифрование

### Основной алгоритм: AES-256-GCM

| Параметр | Значение |
|----------|----------|
| Алгоритм | AES-256-GCM |
| Длина ключа | 256 бит (32 байта) |
| IV (вектор инициализации) | 16 байт (случайный для каждого шифрования) |
| Auth Tag | 16 байт |
| Формат хранения | `iv:authTag:encrypted` (hex) |

Реализация: `fot-server/src/services/encryption.service.ts`

### Что шифруется

1. **TOTP Secret** — генерируется в Base32, шифруется перед сохранением в БД
2. **Коды восстановления** — 10 кодов по 8 символов, каждый шифруется отдельно

### Хэширование

- **SHA-256** используется для поиска данных без расшифровки

## API Эндпоинты

### Аутентификация

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| POST | `/api/auth/login` | Начальный вход, возвращает `requires_2fa: true` если 2FA включена |
| POST | `/api/auth/verify-2fa` | Проверка 6-значного TOTP кода |
| POST | `/api/auth/recovery` | Вход по коду восстановления |

### Администрирование

| Метод | Эндпоинт | Описание |
|-------|----------|----------|
| POST | `/api/admin/users/:id/enable-2fa` | Включение 2FA для пользователя |
| POST | `/api/admin/users/:id/disable-2fa` | Отключение 2FA (при утере устройства) |

## JWT Token

### Структура payload

```typescript
{
  sub: string,                    // User ID
  email: string,                  // Email пользователя
  organization_id: string | null, // ID организации
  role: string,                   // Роль (viewer, accountant, admin, super_admin)
  is_approved: boolean,           // Одобрен ли аккаунт
  two_factor_enabled: boolean,    // 2FA настроена
  two_factor_verified: boolean,   // 2FA пройдена в текущей сессии
  iat: number,                    // Issued at
  exp: number,                    // Expiration
}
```

### Логика проверки

- `two_factor_enabled: true` + `two_factor_verified: false` → требуется ввод TOTP кода
- `two_factor_enabled: true` + `two_factor_verified: true` → полный доступ
- `two_factor_enabled: false` → 2FA не требуется

## Flow включения 2FA

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Админ вызывает POST /api/admin/users/:id/enable-2fa             │
│                          ↓                                          │
│  2. Сервер генерирует:                                              │
│     - TOTP секрет (20 байт, Base32)                                 │
│     - 10 кодов восстановления (8 символов каждый)                   │
│     - QR-код для Google Authenticator / Authy                       │
│                          ↓                                          │
│  3. Секреты шифруются AES-256-GCM и сохраняются в user_profiles     │
│                          ↓                                          │
│  4. Админ получает:                                                 │
│     - secret (для ручного ввода)                                    │
│     - qr_code (Data URL)                                            │
│     - recovery_codes (форматированные XXXX-XXXX)                    │
│                          ↓                                          │
│  5. Админ безопасно передаёт данные пользователю                    │
└─────────────────────────────────────────────────────────────────────┘
```

## Коды восстановления

- **Количество:** 10 кодов
- **Формат:** 8 символов (отображается как XXXX-XXXX)
- **Использование:** одноразовые, удаляются после использования
- **Хранение:** каждый код шифруется отдельно в массиве `recovery_codes`

## Безопасность

1. **Секреты никогда не хранятся в открытом виде** — всегда AES-256-GCM
2. **Ключ шифрования** — 32-байтовый hex из переменной окружения `ENCRYPTION_KEY`
3. **Rate limiting** — защита от brute-force атак на эндпоинтах аутентификации
4. **Audit logging** — все действия с 2FA логируются (2FA_VERIFIED, 2FA_FAILED)

## Файлы реализации

| Файл | Описание |
|------|----------|
| `fot-server/src/services/totp.service.ts` | Генерация TOTP, QR-кодов, проверка кодов |
| `fot-server/src/services/encryption.service.ts` | AES-256-GCM шифрование |
| `fot-server/src/controllers/auth.controller.ts` | Эндпоинты login, verify-2fa, recovery |
| `fot-server/src/controllers/admin.controller.ts` | Эндпоинты enable-2fa, disable-2fa |
| `fot-server/src/middleware/auth.ts` | Проверка JWT и two_factor_verified |
| `fot-app/src/pages/auth/TwoFactorPage.tsx` | UI страница ввода 2FA кода |
