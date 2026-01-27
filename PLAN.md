# План: Двухфакторная аутентификация + Полное шифрование данных

## Архитектура: Гибридная (Вариант 3 Extended)

Supabase MFA (TOTP) + server-side шифрование через Edge Functions + pgsodium для всех таблиц БД.

### Диаграмма потока

```
РЕГИСТРАЦИЯ:
1. Пользователь → AuthPage → Email + Password → Supabase Auth
2. Профиль создан: approved=false, TOTP не настроен
3. Админ → AdminPage → видит нового пользователя
4. Админ → генерирует TOTP secret → QR код
5. Админ → сканирует QR в свой Google Authenticator
6. Админ → сохраняет recovery codes
7. Админ → устанавливает approved=true
8. Пользователю передаются credentials (вне системы)

ЛОГИН:
1. Пользователь → Email + Password → Supabase Auth (AAL1)
2. Система → проверяет наличие TOTP → запрашивает код
3. Пользователь → связывается с админом (телефон/мессенджер)
4. Админ → смотрит код в Google Authenticator
5. Админ → диктует код пользователю
6. Пользователь → вводит код → AAL2 → доступ к порталу

ДОСТУП К ДАННЫМ:
Клиент (React)
  └─ JWT Token (aal2) → Edge Functions API
            ↓
Edge Functions (Deno)
  ├─ Middleware: проверка JWT + AAL2
  ├─ Decrypt: vault.decrypted_secrets + pgsodium
  └─ Response: расшифрованные данные
            ↓
PostgreSQL + pgsodium
  ├─ Все таблицы: зашифрованные колонки (bytea)
  ├─ Master keys в vault.secrets
  └─ RLS: service_role only для encrypted views
```

---

## Phase 1: Критичные данные (Priority 1)

### Таблицы для шифрования

**1. Зарплаты**
- `salary_settings`: base_salary, bonus, transport_base_cost, manual_vacation_rate
- `salary_payments`: amount
- `tender_salary_history`: salary

**2. Здоровье**
- `body_weight`: weight
- `body_params`: bicep_left, bicep_right, forearm_left, forearm_right, chest, shoulders, waist, glutes, calf_left, calf_right, thigh_left, thigh_right

**3. Автомобиль**
- `cars`: vin, purchase_price, current_mileage
- `car_fuel`: liters, price_per_liter, total_cost
- `car_maintenance`: cost
- `car_expenses`: cost

### Миграция БД

Файл: `supabase/migrations/005_encrypt_critical_data.sql`

```sql
-- Включить pgsodium extension
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- Создать master keys
INSERT INTO vault.secrets (name, secret)
VALUES
  ('key_salary', encode(pgsodium.crypto_aead_det_keygen(), 'base64')),
  ('key_health', encode(pgsodium.crypto_aead_det_keygen(), 'base64')),
  ('key_car', encode(pgsodium.crypto_aead_det_keygen(), 'base64'));

-- salary_settings: encrypt numeric fields
ALTER TABLE salary_settings
  ADD COLUMN base_salary_enc bytea,
  ADD COLUMN bonus_enc bytea,
  ADD COLUMN transport_base_cost_enc bytea,
  ADD COLUMN manual_vacation_rate_enc bytea;

-- Migrate existing data
UPDATE salary_settings SET
  base_salary_enc = pgsodium.crypto_aead_det_encrypt(
    base_salary::text::bytea,
    decode((SELECT secret FROM vault.decrypted_secrets WHERE name = 'key_salary'), 'base64'),
    NULL
  ),
  bonus_enc = pgsodium.crypto_aead_det_encrypt(...);

-- Drop plain columns
ALTER TABLE salary_settings
  DROP COLUMN base_salary,
  DROP COLUMN bonus,
  DROP COLUMN transport_base_cost,
  DROP COLUMN manual_vacation_rate;

-- Аналогично для остальных таблиц Phase 1...

-- Создать decrypted views
CREATE VIEW salary_settings_decrypted AS
SELECT
  id, user_id, year, month,
  convert_from(
    pgsodium.crypto_aead_det_decrypt(
      base_salary_enc,
      decode((SELECT secret FROM vault.decrypted_secrets WHERE name = 'key_salary'), 'base64'),
      NULL
    ), 'UTF8'
  )::numeric AS base_salary,
  -- ... остальные поля
FROM salary_settings;

-- RLS: только service_role
ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON salary_settings FROM authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON salary_settings_decrypted TO service_role;
```

### Edge Function: Критичные данные

Файл: `supabase/functions/secure-api/index.ts`

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  // 1. Проверка Authorization header
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return new Response('Unauthorized', { status: 401 })

  // 2. Проверка AAL2 (MFA verified)
  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } }
  })

  const { data: { user }, error } = await userClient.auth.getUser(
    authHeader.replace('Bearer ', '')
  )

  if (error || !user) {
    return new Response('Invalid token', { status: 401 })
  }

  // Проверка AAL2 level (MFA)
  const { data: { session } } = await userClient.auth.getSession()
  if (session?.user.aal !== 'aal2') {
    return new Response('MFA required', { status: 403 })
  }

  // 3. Routing
  const { action, payload } = await req.json()
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  switch (action) {
    case 'get_salary_settings': {
      const { year, month } = payload
      const { data } = await adminClient
        .from('salary_settings_decrypted')
        .select('*')
        .eq('user_id', user.id)
        .eq('year', year)
        .eq('month', month)
        .single()
      return new Response(JSON.stringify(data), { status: 200 })
    }

    case 'update_salary_settings': {
      // Encrypt + save logic
      const { id, base_salary, bonus } = payload
      const { data } = await adminClient
        .from('salary_settings_decrypted')
        .update({ base_salary, bonus })
        .eq('id', id)
        .eq('user_id', user.id)
      return new Response(JSON.stringify(data), { status: 200 })
    }

    case 'get_body_weight': { /* ... */ }
    case 'get_car_data': { /* ... */ }

    default:
      return new Response('Unknown action', { status: 400 })
  }
})
```

### Клиентский API Wrapper

Файл: `src/lib/secureApi.ts`

```typescript
import { supabase } from './supabase'

const EDGE_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/secure-api`

async function callSecureApi(action: string, payload: any) {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session?.access_token) {
    throw new Error('Not authenticated')
  }

  const res = await fetch(EDGE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action, payload })
  })

  if (!res.ok) {
    const error = await res.text()
    throw new Error(error)
  }

  return res.json()
}

// Salary API
export const secureApi = {
  salary: {
    getSettings: (year: number, month: number) =>
      callSecureApi('get_salary_settings', { year, month }),

    updateSettings: (id: string, data: any) =>
      callSecureApi('update_salary_settings', { id, ...data }),

    getPayments: (year: number, month: number) =>
      callSecureApi('get_salary_payments', { year, month })
  },

  health: {
    getWeight: (userId: string) =>
      callSecureApi('get_body_weight', { userId }),

    getParams: (userId: string) =>
      callSecureApi('get_body_params', { userId })
  },

  car: {
    getCars: () => callSecureApi('get_car_data', {}),

    getFuel: (carId: string) =>
      callSecureApi('get_car_fuel', { carId })
  }
}
```

### Рефакторинг компонентов

**1. SalaryMonthPage.tsx**

```typescript
// Было:
const { data } = await supabase
  .from('salary_settings')
  .select('*')

// Стало:
const data = await secureApi.salary.getSettings(year, month)
```

**2. Body Weight/Params страницы**

Аналогично - заменить прямые запросы на `secureApi.health.*`

**3. Car страницы**

Заменить на `secureApi.car.*` для VIN и cost полей

---

## Phase 2: MFA Setup (Admin-Controlled)

### Миграция БД: Хранение recovery codes

Файл: `supabase/migrations/005_mfa_recovery_codes.sql`

```sql
-- Таблица для хранения recovery codes (только для админа)
CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,  -- bcrypt hash кода
  used_at timestamp,
  created_at timestamp DEFAULT now(),
  UNIQUE(user_id, code_hash)
);

-- RLS: только admin может читать
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin read recovery codes"
  ON mfa_recovery_codes
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.is_admin = true
    )
  );
```

### Файлы для создания

**1. Компонент Admin MFA Setup**

Файл: `src/components/AdminMFASetup.tsx`

```typescript
import { useState } from 'react'
import { supabase } from '../lib/supabase'
import QRCode from 'qrcode'
import * as speakeasy from 'speakeasy'

interface Props {
  userId: string
  userEmail: string
}

export function AdminMFASetup({ userId, userEmail }: Props) {
  const [qrCode, setQrCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [totpSecret, setTotpSecret] = useState('')

  const generateTOTP = async () => {
    // 1. Генерация TOTP secret через Edge Function
    const { data: { session } } = await supabase.auth.getSession()

    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-mfa-setup`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ userId, userEmail })
      }
    )

    const { qrCodeUrl, secret, recoveryCodes: codes } = await res.json()

    // 2. Отобразить QR код админу
    const qr = await QRCode.toDataURL(qrCodeUrl)
    setQrCode(qr)
    setTotpSecret(secret)
    setRecoveryCodes(codes)
  }

  const printRecoveryCodes = () => {
    const printWindow = window.open('', '', 'width=600,height=400')
    printWindow.document.write(`
      <h1>Recovery Codes для ${userEmail}</h1>
      <p>Сохраните эти коды в безопасном месте:</p>
      <ul>
        ${recoveryCodes.map(code => `<li>${code}</li>`).join('')}
      </ul>
    `)
    printWindow.print()
  }

  return (
    <div>
      <button onClick={generateTOTP}>Генерировать TOTP</button>

      {qrCode && (
        <div>
          <h3>Сканируйте QR код в Google Authenticator</h3>
          <img src={qrCode} alt="TOTP QR Code" />

          <p>Или введите вручную: <code>{totpSecret}</code></p>

          <h3>Recovery Codes</h3>
          <ul>
            {recoveryCodes.map(code => <li key={code}>{code}</li>)}
          </ul>

          <button onClick={printRecoveryCodes}>Печать кодов</button>
        </div>
      )}
    </div>
  )
}
```

**2. Edge Function: Admin MFA Setup**

Файл: `supabase/functions/admin-mfa-setup/index.ts`

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from '@supabase/supabase-js'
import * as speakeasy from 'https://esm.sh/speakeasy@2.0.0'
import * as bcrypt from 'https://deno.land/x/bcrypt/mod.ts'

serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  // Проверка: только admin
  const { data: { user } } = await supabase.auth.getUser(
    authHeader.replace('Bearer ', '')
  )

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single()

  if (!profile?.is_admin) {
    return new Response('Forbidden', { status: 403 })
  }

  // Генерация TOTP secret
  const { userId, userEmail } = await req.json()

  const secret = speakeasy.generateSecret({
    name: `OdintsovLive Portal (${userEmail})`,
    length: 32
  })

  // Сохранить secret в auth.mfa_factors
  const { error: enrollError } = await supabase.auth.admin.mfa.enroll({
    userId,
    factorType: 'totp',
    issuer: 'OdintsovLive Portal',
    friendlyName: userEmail
  })

  if (enrollError) throw enrollError

  // Генерация 10 recovery codes
  const recoveryCodes = Array.from({ length: 10 }, () => {
    return Math.random().toString(36).substring(2, 10).toUpperCase()
  })

  // Сохранить recovery codes (hashed)
  for (const code of recoveryCodes) {
    const hash = await bcrypt.hash(code)
    await supabase.from('mfa_recovery_codes').insert({
      user_id: userId,
      code_hash: hash
    })
  }

  return new Response(JSON.stringify({
    qrCodeUrl: secret.otpauth_url,
    secret: secret.base32,
    recoveryCodes
  }), { status: 200 })
})
```

**3. Компонент Verify MFA (при логине)**

Файл: `src/components/MFAVerify.tsx`

```typescript
import { useState } from 'react'
import { supabase } from '../lib/supabase'

export function MFAVerify({ onSuccess }: { onSuccess: () => void }) {
  const [code, setCode] = useState('')
  const [isRecoveryCode, setIsRecoveryCode] = useState(false)

  const verify = async () => {
    if (isRecoveryCode) {
      // Verify recovery code через Edge Function
      const { data: { session } } = await supabase.auth.getSession()

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-recovery-code`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ code })
        }
      )

      if (res.ok) {
        onSuccess()
      }
    } else {
      // Verify TOTP code
      const factors = await supabase.auth.mfa.listFactors()
      const factorId = factors.data.totp[0].id

      const challenge = await supabase.auth.mfa.challenge({ factorId })
      if (challenge.error) throw challenge.error

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.data.id,
        code
      })

      if (!verifyError) onSuccess()
    }
  }

  return (
    <div>
      <h2>Двухфакторная аутентификация</h2>
      <p>Свяжитесь с администратором для получения кода</p>

      <input
        value={code}
        onChange={e => setCode(e.target.value)}
        placeholder={isRecoveryCode ? "Recovery код" : "6-значный код"}
      />

      <button onClick={verify}>Войти</button>

      <button onClick={() => setIsRecoveryCode(!isRecoveryCode)}>
        {isRecoveryCode ? 'Использовать TOTP код' : 'Использовать recovery код'}
      </button>
    </div>
  )
}
```

**3. Обновление App.tsx**

```typescript
// Проверка AAL level после логина
useEffect(() => {
  const checkMFA = async () => {
    const { data: { session } } = await supabase.auth.getSession()

    if (session?.user) {
      // Проверяем AAL level
      const aal = session.user.aal

      if (aal === 'aal1') {
        // Требуется MFA verification
        setShowMFAVerify(true)
      } else if (aal === 'aal2') {
        // MFA пройден, загружаем профиль
        loadProfile()
      }
    }
  }

  checkMFA()
}, [])
```

**4. Обновление AdminPage.tsx**

Добавить управление TOTP для каждого пользователя:

```typescript
// В списке пользователей добавить колонку "MFA Status" и кнопку "Генерировать TOTP"
import { AdminMFASetup } from '../components/AdminMFASetup'

export function AdminPage() {
  const [selectedUser, setSelectedUser] = useState(null)
  const [showMFASetup, setShowMFASetup] = useState(false)

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Approved</th>
            <th>MFA Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id}>
              <td>{user.email}</td>
              <td>{user.approved ? 'Да' : 'Нет'}</td>
              <td>{user.mfa_enabled ? 'Да' : 'Нет'}</td>
              <td>
                <button onClick={() => toggleApproved(user.id)}>
                  {user.approved ? 'Отклонить' : 'Одобрить'}
                </button>
                <button onClick={() => {
                  setSelectedUser(user)
                  setShowMFASetup(true)
                }}>
                  Генерировать TOTP
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showMFASetup && selectedUser && (
        <AdminMFASetup
          userId={selectedUser.id}
          userEmail={selectedUser.email}
        />
      )}
    </div>
  )
}
```

**5. Обновление AuthPage.tsx**

После успешного логина проверить, настроен ли TOTP:

```typescript
const handleLogin = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email, password
  })

  if (!error) {
    // Проверяем, одобрен ли пользователь
    const { data: profile } = await supabase
      .from('profiles')
      .select('approved')
      .eq('id', data.user.id)
      .single()

    if (!profile?.approved) {
      setError('Аккаунт не одобрен администратором')
      return
    }

    // Проверяем, есть ли MFA factors
    const factors = await supabase.auth.mfa.listFactors()

    if (factors.data.totp.length === 0) {
      setError('MFA не настроен. Обратитесь к администратору.')
      return
    }

    // MFA настроен → показать MFAVerify
    setShowMFAVerify(true)
  }
}
```

---

## Phase 3: Расширенное шифрование (Priority 2)

### Таблицы

**1. Коммунальные платежи**
- `rent_records`: rent_amount, utilities_amount, cold_water, hot_water, water_amount, electricity_amount, electricity (jsonb)

**2. Заметки**
- `notes`: title, content

**3. Имена сотрудников**
- `tender_employees`: full_name (предположительно)

Создать миграцию `006_encrypt_extended_data.sql` по аналогии с Phase 1.

Расширить Edge Function новыми actions:
- `get_rent_records`
- `get_notes`
- `get_tender_employees`

Обновить `src/lib/secureApi.ts` новыми методами.

---

## Phase 4: Полное шифрование (Priority 3)

### Таблицы

**1. Календарь**
- `calendar_days`: status (если содержит чувствительные статусы)

**2. Остальные таблицы**
- Все поля, содержащие PII или финансы

Создать финальную миграцию `007_encrypt_all_remaining.sql`.

Все запросы переключить на Edge Functions API.

---

## Критические файлы для изменения

### Новые файлы

1. `supabase/migrations/005_mfa_recovery_codes.sql` - таблица recovery codes
2. `supabase/migrations/006_encrypt_critical_data.sql` - шифрование Phase 1
3. `supabase/migrations/007_encrypt_extended_data.sql` - шифрование Phase 2
4. `supabase/migrations/008_encrypt_all_remaining.sql` - шифрование Phase 3
5. `supabase/functions/secure-api/index.ts` - Edge Function API
6. `supabase/functions/admin-mfa-setup/index.ts` - Edge Function для генерации TOTP (admin only)
7. `supabase/functions/verify-recovery-code/index.ts` - Edge Function для проверки recovery кодов
8. `src/lib/secureApi.ts` - клиентский wrapper
9. `src/components/AdminMFASetup.tsx` - генерация TOTP админом
10. `src/components/MFAVerify.tsx` - проверка TOTP при логине

### Изменяемые файлы

1. [src/App.tsx](src/App.tsx) - добавить MFA flow, проверка AAL2
2. [src/pages/AuthPage.tsx](src/pages/AuthPage.tsx) - интеграция MFAVerify (без самостоятельной регистрации TOTP)
3. [src/pages/AdminPage.tsx](src/pages/AdminPage.tsx) - добавить AdminMFASetup, показать MFA status
4. [src/lib/supabase.ts](src/lib/supabase.ts) - добавить константы для Edge Functions
5. [src/pages/SalaryMonthPage.tsx](src/pages/SalaryMonthPage.tsx) - использовать secureApi.salary
6. [src/pages/tender/hooks/useTenderData.ts](src/pages/tender/hooks/useTenderData.ts) - secureApi.tender
7. Все страницы с body_weight, body_params, car данными

---

## Tech Stack

### Библиотеки

```json
{
  "dependencies": {
    "qrcode": "^1.5.3",           // Генерация QR кодов для TOTP
    "@types/qrcode": "^1.5.5",    // TypeScript types
    "speakeasy": "^2.0.0",        // TOTP генерация/верификация (для Edge Functions)
    "@types/speakeasy": "^2.0.7"  // TypeScript types
  }
}
```

### Supabase Extensions

- `pgsodium` - hardware-accelerated encryption
- `vault.secrets` - хранилище master keys

---

## План реализации (10-12 дней)

### День 1-2: MFA Setup (Admin-Controlled)
- [ ] Установить `qrcode`, `speakeasy` библиотеки
- [ ] Создать миграцию 005_mfa_recovery_codes.sql
- [ ] Создать Edge Function admin-mfa-setup
- [ ] Создать Edge Function verify-recovery-code
- [ ] Создать компонент AdminMFASetup (генерация TOTP админом)
- [ ] Создать компонент MFAVerify (проверка кода при логине)
- [ ] Обновить AdminPage.tsx (добавить кнопку "Генерировать TOTP", показать MFA status)
- [ ] Обновить AuthPage.tsx (MFA flow без самостоятельной настройки)
- [ ] Обновить App.tsx для проверки AAL level
- [ ] Тестирование: админ генерирует TOTP → сканирует в свой Google Authenticator → пользователь логинится с кодом от админа

### День 3-5: Phase 1 - Критичные данные
- [ ] Создать миграцию 006_encrypt_critical_data.sql
- [ ] Запустить миграцию, проверить vault.secrets
- [ ] Создать Edge Function secure-api
- [ ] Реализовать actions для salary, health, car
- [ ] Создать src/lib/secureApi.ts wrapper
- [ ] Deploy Edge Functions (admin-mfa-setup, verify-recovery-code, secure-api)
- [ ] Рефакторинг SalaryMonthPage.tsx
- [ ] Рефакторинг body_weight, body_params страниц
- [ ] Рефакторинг car страниц
- [ ] Тестирование: encrypt → save → decrypt → display

### День 6-8: Phase 2 - Расширенное шифрование
- [ ] Создать миграцию 007_encrypt_extended_data.sql
- [ ] Добавить rent_records encryption
- [ ] Добавить notes encryption
- [ ] Добавить tender_employees.full_name encryption
- [ ] Расширить Edge Function новыми actions
- [ ] Обновить secureApi.ts
- [ ] Рефакторинг страниц rent, notes, tender
- [ ] Тестирование Phase 2

### День 9-11: Phase 3 - Полное шифрование
- [ ] Создать миграцию 008_encrypt_all_remaining.sql
- [ ] Зашифровать calendar_days
- [ ] Зашифровать все оставшиеся таблицы
- [ ] Переключить ВСЕ запросы на Edge Functions
- [ ] Убрать RLS policies на plain таблицы (только service_role)
- [ ] Full regression testing

### День 12: Security Audit & Documentation
- [ ] Проверка AAL2 enforcement на всех endpoints
- [ ] Проверка, что все чувствительные поля зашифрованы
- [ ] Тестирование edge cases (смена пароля, logout, token expiry)
- [ ] Документация по настройке MFA для пользователей
- [ ] Backup стратегия для vault.secrets keys

---

## Проверка реализации (End-to-End Testing)

### 1. MFA Flow (Admin-Controlled)
```
РЕГИСТРАЦИЯ:
1. Пользователь → AuthPage → Email + Password → Аккаунт создан (approved=false)
2. Админ → AdminPage → видит нового пользователя
3. Админ → нажимает "Генерировать TOTP"
4. Система → показывает QR код + recovery codes
5. Админ → сканирует QR в свой Google Authenticator
6. Админ → сохраняет/печатает recovery codes
7. Админ → устанавливает approved=true
8. Админ → передаёт credentials пользователю (вне системы)

ЛОГИН:
1. Пользователь → Email + Password → AAL1
2. Система → "Введите код 2FA (свяжитесь с админом)"
3. Пользователь → связывается с админом (телефон/Telegram)
4. Админ → открывает Google Authenticator → видит код для этой учётки
5. Админ → диктует код пользователю
6. Пользователь → вводит код → AAL2 → доступ к порталу

RECOVERY:
1. Пользователь → "Использовать recovery код"
2. Админ → диктует один из 10 кодов
3. Пользователь → вводит код → AAL2 → доступ
4. Recovery код помечается как использованный
```

### 2. Шифрование данных
```
1. Открыть страницу зарплаты
2. Изменить base_salary → 150000
3. Проверить в БД: salary_settings.base_salary_enc = bytea (зашифровано)
4. Refresh страницы → Видим 150000 (расшифровано через Edge Function)
```

### 3. Без MFA = нет доступа
```
1. Открыть Supabase SQL Editor
2. SELECT * FROM salary_settings → видим только encrypted bytea
3. SELECT * FROM salary_settings_decrypted → Permission denied (RLS)
4. Попытка обойти через прямой supabase.from() → Error 403
```

### 4. Logout & Re-login
```
1. Logout
2. Login → Требует TOTP код
3. Ввести код → AAL2 → Доступ к данным
```

---

## Security Checklist

- [x] 2FA через Google Authenticator (TOTP)
- [x] Server-side шифрование (pgsodium)
- [x] Master keys в vault.secrets (encrypted at rest)
- [x] RLS: service_role only для decrypted views
- [x] JWT AAL2 level проверка в Edge Functions
- [x] Все критичные данные зашифрованы
- [x] Прямой доступ к БД заблокирован (no anon/authenticated access)
- [x] Audit log возможен (через Edge Function logging)
- [x] Backup стратегия для vault keys

---

## Риски и Mitigation

### Риск 1: Потеря TOTP secret (админ потерял телефон)
**Mitigation:**
- 10 recovery codes хранятся в БД (hashed)
- Админ может использовать recovery код для логина
- Админ может сгенерировать новый TOTP secret через SQL backup access
- Offline backup TOTP secrets в 1Password/Hardware Security Module

### Риск 2: Потеря vault.secrets key
**Mitigation:** Backup ключей в secure offline storage (1Password, Hardware Security Module)

### Риск 3: Edge Function downtime
**Mitigation:** Implement retry logic в secureApi.ts + fallback error UI

### Риск 4: Performance деградация
**Mitigation:**
- Кеширование расшифрованных данных в Edge Function (Redis/Deno KV)
- Connection pooling для PostgreSQL

---

## Примечания

1. **ВАЖНО**: Перед запуском миграций - сделать полный backup БД
2. Миграцию данных лучше делать поэтапно (сначала создать `_enc` колонки, потом дропать plain)
3. Master keys из vault.secrets нужно сохранить в безопасное место (offline backup)
4. После Phase 3 - весь код будет использовать только Edge Functions API
5. RLS останется только для `profiles` таблицы (admin approval flow)
