# Шифрование данных

## Обзор

Система использует симметричное шифрование для защиты чувствительных данных перед сохранением в базу данных.

## Основной алгоритм: AES-256-GCM

**AES-256-GCM** (Advanced Encryption Standard с Galois/Counter Mode) — современный стандарт шифрования с аутентификацией.

### Параметры

| Параметр | Значение | Описание |
|----------|----------|----------|
| Алгоритм | AES-256 | 256-битный ключ шифрования |
| Режим | GCM | Galois/Counter Mode с аутентификацией |
| Длина ключа | 32 байта (256 бит) | Из переменной `ENCRYPTION_KEY` |
| IV (Initialization Vector) | 16 байт | Генерируется случайно для каждого шифрования |
| Auth Tag | 16 байт | Тег аутентификации для проверки целостности |

### Преимущества GCM

1. **Аутентификация** — встроенная проверка целостности данных
2. **Производительность** — аппаратное ускорение на современных процессорах
3. **Параллелизация** — возможность параллельного шифрования/дешифрования
4. **Стандарт** — рекомендован NIST, используется в TLS 1.3

## Формат хранения

Зашифрованные данные хранятся в формате:

```
iv:authTag:encrypted
```

| Часть | Размер | Описание |
|-------|--------|----------|
| iv | 32 hex символа (16 байт) | Вектор инициализации |
| authTag | 32 hex символа (16 байт) | Тег аутентификации |
| encrypted | переменный | Зашифрованные данные |

**Пример:**
```
a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6:f1e2d3c4b5a6978869584736251403f2:8a9b7c6d5e4f3a2b1c0d
```

## API сервиса шифрования

Реализация: `fot-server/src/services/encryption.service.ts`

### encrypt(text: string): string

Шифрует текст и возвращает строку в формате `iv:authTag:encrypted`.

```typescript
const encrypted = encryptionService.encrypt('secret data');
// "a1b2c3....:f1e2d3....:8a9b7c...."
```

### decrypt(encryptedData: string): string

Расшифровывает данные из формата `iv:authTag:encrypted`.

```typescript
const decrypted = encryptionService.decrypt(encrypted);
// "secret data"
```

### encryptField(value: string | null | undefined): string | null

Безопасно шифрует поле (возвращает `null` если входное значение `null`/`undefined`).

```typescript
const encrypted = encryptionService.encryptField(user.phone);
// null если phone не задан, иначе зашифрованная строка
```

### decryptField(value: string | null | undefined): string | null

Безопасно расшифровывает поле с обработкой ошибок.

```typescript
const phone = encryptionService.decryptField(user.encrypted_phone);
// null если ошибка или поле пустое
```

### hash(text: string): string

Хэширует строку с использованием SHA-256 (для поиска без расшифровки).

```typescript
const hash = encryptionService.hash('search term');
// "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

### generateKey(): string

Генерирует случайный 256-битный ключ шифрования (для начальной настройки).

```typescript
const newKey = encryptionService.generateKey();
// "a1b2c3d4e5f6..."  (64 hex символа = 32 байта)
```

## Хэширование: SHA-256

Используется для создания поисковых индексов без возможности восстановления оригинальных данных.

| Параметр | Значение |
|----------|----------|
| Алгоритм | SHA-256 |
| Размер хэша | 256 бит (64 hex символа) |
| Нормализация | toLowerCase() + trim() |

### Применение

- Поиск по зашифрованным полям без расшифровки
- Создание индексов для быстрого поиска
- Проверка уникальности данных

## Конфигурация

### Переменные окружения

| Переменная | Описание | Формат |
|------------|----------|--------|
| `ENCRYPTION_KEY` | Мастер-ключ шифрования | 64 hex символа (32 байта) |

### Генерация ключа

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32
```

### Валидация ключа

При запуске сервера проверяется:
- Ключ должен быть ровно 32 байта (64 hex символа)
- При несоответствии — ошибка и остановка сервера

```typescript
if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
}
```

## Что шифруется

| Данные | Таблица | Поле |
|--------|---------|------|
| TOTP секреты | user_profiles | totp_secret |
| Коды восстановления | user_profiles | recovery_codes |
| Персональные данные сотрудников | employees | encrypted_* поля |

## Безопасность

### Рекомендации

1. **Храните ключ безопасно** — используйте переменные окружения или secret manager
2. **Не логируйте ключ** — никогда не выводите ключ в логи
3. **Ротация ключей** — при компрометации требуется перешифровка всех данных
4. **Backup ключа** — потеря ключа = потеря всех зашифрованных данных

### Угрозы и защита

| Угроза | Защита |
|--------|--------|
| Утечка БД | Данные зашифрованы, без ключа бесполезны |
| Подмена данных | Auth Tag обнаружит изменения |
| Replay атаки | Уникальный IV для каждого шифрования |
| Brute-force | 256-битный ключ = 2^256 комбинаций |

## Файлы реализации

| Файл | Описание |
|------|----------|
| `fot-server/src/services/encryption.service.ts` | Основной сервис шифрования |
| `fot-server/src/config/env.ts` | Загрузка ENCRYPTION_KEY |
| `fot-server/src/services/totp.service.ts` | Использует encryption для TOTP |

## Пример использования

```typescript
import { encryptionService } from './services/encryption.service.js';

// Шифрование перед сохранением в БД
const employee = {
  name: 'Иван Иванов',
  phone_encrypted: encryptionService.encrypt('+79001234567'),
  phone_hash: encryptionService.hash('+79001234567'), // для поиска
};

await supabase.from('employees').insert(employee);

// Расшифровка при чтении
const { data } = await supabase.from('employees').select('*').single();
const phone = encryptionService.decrypt(data.phone_encrypted);
// "+79001234567"
```
