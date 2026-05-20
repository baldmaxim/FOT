# Руководство по МТС API «Мобильные сотрудники»

> Практическое руководство для разработчиков FOT по интеграции с API «МТС Мобильные сотрудники»
> (сервис M-Poisk под брендом МТС). Дополняет технический контракт
> [docs/mts-mobile-staff-api.md](mts-mobile-staff-api.md): даёт пошаговый ввод в эксплуатацию,
> диагностику типовых ошибок и **главное — чёткое разделение бесплатных и платных вызовов**.
>
> Источники: официальный портал `developers.mts.ru/traveling-staff`, ЛК M-Poisk
> (`enter.mpoisk.ru/help-center/integration/api`), Swagger `api.mpoisk.ru/v6/swagger/ui/index`,
> код сервиса [fot-server/src/services/mts-data.service.ts](../fot-server/src/services/mts-data.service.ts)
> и диагностический скрипт [fot-server/scripts/mts-fetch-subscribers.mjs](../fot-server/scripts/mts-fetch-subscribers.mjs).

---

## ⚠️ Тарификация — главное правило

**Каждый вызов МТС API в проекте FOT обязан соответствовать этой таблице. Если ваш код добавляет
новый вызов — проверьте, в какую категорию он попадает, и явно отметьте это комментарием.**

### 🟢 Бесплатные (GET) — можно дёргать свободно

| Эндпоинт МТС | Метод в `mtsDataService` | Назначение |
|---|---|---|
| `GET /subscriberManagement/subscribers` | `getSubscribers()` | список абонентов (с `withCustomTemplateItems=true`) |
| `GET /subscriberManagement/subscribers/{id}` | — | один абонент |
| `GET /subscriberManagement/subscribers/lastLocations` | `getLastLocations()` | последние известные позиции |
| `GET /subscriberManagement/subscriberGroups` | `getSubscriberGroups()` | список групп |
| `GET /subscriberManagement/subscriberGroups/{id}` | `getSubscriberGroupDetails()` | детали группы |
| `GET /mobilePositioningManagement/locations` | `getLocationsRange()` | исторические LBS-локации |
| `GET /mobilePositioningManagement/tracks` | `getTrack()`, `getTracksRange()` | агрегированные треки |
| `GET /globalPositioningManagement/locations` | `getGlobalLocations()` | GPS-точки с приложения МТС-Координатор |
| `GET /customFieldsManagement/customFields` | `getCustomFields()` | определения шаблонов кастомных полей |
| `GET /taskManagement/tasks/{id}` | `getTaskMts()` | данные одной задачи |

Эти эндпоинты **читают уже накопленные данные** и не инициируют платных операций у оператора.

### 🔴 Платные — только с явным согласием пользователя

| Эндпоинт МТС | Метод в `mtsDataService` | Тариф | Защита |
|---|---|---|---|
| `POST /subscriberManagement/subscriberRequests` | `requestLocation(subscriberId)` | ~3–5 ₽/запрос | super_admin + critical 2FA + явное `confirmed:true` |

Только ручное действие. **Не должно дёргаться:** в `useQuery`, в фоновых поллерах, в массовых операциях.

### ⚪ В рамках подписки — не пер-запросное списание

| Эндпоинт МТС | Метод | Примечание |
|---|---|---|
| `POST /taskManagement/tasks` | `createTaskMts()` | создание задачи — входит в тариф «Мобильные сотрудники» |

### Проверка собственного кода

Перед коммитом, добавляющего новый вызов МТС, выполнить:

```powershell
git grep -n 'subscriberRequests\|requestLocation' fot-server/src
```

Допустимое число вхождений: **ровно два** —
[fot-server/src/services/mts-data.service.ts](../fot-server/src/services/mts-data.service.ts) (определение метода)
и [fot-server/src/controllers/mts.controller.ts](../fot-server/src/controllers/mts.controller.ts) (его вызов с 2FA-защитой).
Любое лишнее — потенциальная утечка платных вызовов.

---

## 1. Что такое модуль

МТС «Мобильные сотрудники» — это re-skin сервиса **M-Poisk** под брендом МТС. Сервис позволяет
отслеживать местоположение сотрудников по их SIM-картам МТС (LBS, бесплатно регулярно) и через
мобильное приложение МТС-Координатор (GPS, бесплатно).

В FOT модуль используется на странице `/mts` ([MtsPage.tsx](../fot-app/src/pages/mts/MtsPage.tsx))
для:
- просмотра абонентов МТС и их статуса,
- привязки абонента к сотруднику FOT (таблица `mts_subscriber_map`),
- просмотра треков и GPS-точек за выбранный период,
- создания задач для выездного персонала.

Фоновый поллер
[mts-location-poller.service.ts](../fot-server/src/services/mts-location-poller.service.ts) раз в
час (env `MTS_SYNC_INTERVAL_MS`) подтягивает `lastLocations` и шифрованно сохраняет в
`mts_location_snapshots` (AES-256-GCM) — открытых геоданных в БД нет.

---

## 2. Получение токена

1. Войдите в **личный кабинет M-Poisk**: <https://enter.mpoisk.ru>.
2. Меню профиля → **Настройки** → вкладка **«Интеграция по API»**.
3. Нажмите **«Создать токен»** → подтвердите SMS-кодом (код действует 5 минут).
4. Токен **показывается один раз** — скопируйте сразу и сохраните в менеджер паролей.

**Формат токена:** JWE (`alg: ECDH-ES+A256KW`, `enc: A256CBC-HS512`) — для приложения это
непрозрачная строка длиной ~600+ символов.

**Сохранение в FOT (UI):**
1. `/mts` → блок «Подключение МТС "Мобильные сотрудники"» → кнопка **«Изменить»**.
2. Вставьте токен в поле «API-токен», при желании укажите base URL (по умолчанию
   `https://api.mpoisk.ru/v6/api`).
3. Нажмите «Сохранить» — потребуется ввод кода 2FA.

Токен шифруется (`encryptionService.encrypt`) и сохраняется в таблицу `system_settings`
(`mts_api_token`). Расшифровка делается серверным
[settingsService.getResolvedMtsConfig()](../fot-server/src/services/settings.service.ts).

**Альтернатива через env** (если БД-настройки не заданы):

```env
MTS_API_BASE_URL=https://api.mpoisk.ru/v6/api
MTS_API_TOKEN=<JWE-токен>
```

Приоритет: `system_settings` → `env` → дефолт.

---

## 3. Авторизация

| Заголовок | Значение |
|---|---|
| `Authorization` | `Bearer <JWE-токен>` |
| `Content-Type` | `application/json` |

### Формат дат

ISO-8601, **один формат в одном запросе**:
- local: `2026-01-07T00:00:00`
- UTC: `2026-01-07T00:00:00Z`
- offset: `2026-01-07T00:00:00+03:00`

**Смешивать форматы в `dateFrom`/`dateTo` одного запроса нельзя** → код `225 REQUEST_DATE_TIME_INCONSISTENT_FORMAT`.

В коде FOT используется local-формат без TZ:
```typescript
const trim = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, '');
```

---

## 4. Эндпоинты и поля ответа

### Абонент (subscriber)

```json
{
  "subscriberID": 12345,
  "name": "Иванов И.И.",
  "phone": "79991234567",
  "isOnline": true,
  "canTrack": true,
  "isLocateEnabled": true,
  "longitude": 37.6173,
  "latitude": 55.7558,
  "radius": 100,
  "subscriberGroupIDs": [1, 2],
  "customTemplateItems": [{ "customFieldID": 5, "value": "..." }]
}
```

Фильтры `GET /subscribers`: `isActive`, `subscriberIDs`, `subscriberGroupIDs`, `dateFrom`,
`dateTo`, `withCustomTemplateItems` (рекомендуется `true`).

> ⚠️ В FOT с коммита 6949252 фильтр `isActive=true` **снят** — некоторые абоненты, добавленные
> через CSV-импорт или из приложения МТС-Координатор, не имеют этого флага и иначе пропадают
> из списка.

### Локация (LBS, `lastLocations` или `/mobilePositioningManagement/locations`)

```json
{
  "locationID": 98765,
  "subscriberID": 12345,
  "locationDate": "2026-05-20T14:30:00",
  "requestDate": "2026-05-20T14:30:01",
  "latitude": 55.7558,
  "longitude": 37.6173,
  "accuracy": 250,
  "address": "Москва, Тверская ул., 1",
  "state": "FRESH",
  "source": "LBS"
}
```

### Трек (`/mobilePositioningManagement/tracks`)

```json
{
  "trackID": 555,
  "subscriberID": 12345,
  "startDate": "2026-05-20T08:00:00",
  "finishDate": "2026-05-20T09:15:00",
  "startAddress": "Москва, Тверская ул., 1",
  "finishAddress": "Москва, Арбат, 24",
  "startLat": 55.7558, "startLon": 37.6173,
  "finishLat": 55.7510, "finishLon": 37.5950,
  "distance": 4500,
  "duration": 4500
}
```

### GPS-точка (`/globalPositioningManagement/locations`)

```json
{
  "locationID": 333,
  "subscriberID": 12345,
  "locationDate": "2026-05-20T14:30:00",
  "latitude": 55.7558,
  "longitude": 37.6173,
  "angle": 90,
  "velocity": 45,
  "isValid": true
}
```

### Группа абонентов (`/subscriberGroups`)

```json
{ "subscriberGroupID": 7, "name": "Курьеры центр" }
```

### Кастомное поле (`/customFieldsManagement/customFields`)

```json
{ "customFieldID": 5, "name": "ИНН", "type": "STRING", "isRequired": false }
```

### Задача (`/taskManagement/tasks`)

Обязательные поля создания: `title`, `startDate`. Опциональные: `subscriberID`, `deadline`,
`description`, `address`, `longitude`, `latitude`, `externalID`, `clientName`, `clientPhone`,
`priority`, `status`, `taskTypeID`. В ответе появляются `taskID`, `creationDate`, `routeItems[]`.

---

## 5. Лимиты

| Лимит | Значение | Симптом |
|---|---|---|
| Размер LBS-выборки | ≤ 200 элементов | код `66 COUNT_LIMIT_EXCEEDED` |
| Размер GPS-выборки | ≤ 1000 элементов | код `67 INVALID_NUMBER_OF_ELEMENTS` |
| Частота `subscriberRequests` на абонента | по тарифу | код `588 REQUEST_FREQUENCY_EXCEEDED` |
| Суточный лимит планирования | по тарифу | `REQUEST_LIMIT_EXCEEDED` |

Пагинация в LBS/GPS — по `lastLocationID` / `lastTrackID` (cursor-based). Реализовано в
[mts-data.service.ts → paginate()](../fot-server/src/services/mts-data.service.ts).

---

## 6. Коды ошибок

### HTTP-коды

`200, 201, 204` — ок; `301/302` — редирект; `400` — bad request; `401` — нет/просрочен токен;
`403` — нет прав на ресурс; `404` — не найдено; `405` — метод не разрешён; `500–504` — серверные.

### Функциональные коды (поле `code` в теле ошибки)

| Код | Имя | Когда |
|---|---|---|
| 0 | OK | успех |
| 1 | USER_UNAUTHORIZED | токен невалидный/просрочен |
| 2 | BAD_REQUEST | параметры запроса не прошли валидацию |
| 3 | INTERNAL_SERVER_ERROR | сторона МТС |
| 4 | SUBSCRIBER_EXTERNAL_ID_EXISTS | при создании дубликата |
| 12 | NO_SUCH_SUBSCRIBER | абонент не существует / нет доступа |
| 18 | TASK_NOT_FOUND | задача не найдена |
| 22 | TITLE_IS_NEEDED | при создании задачи без `title` |
| 33 | INVALID_TASK_START_DATE | `startDate` в прошлом / неверный |
| 50 | TASKS_NOT_FOUND | нет задач по фильтру |
| 52 | NULL_ARGUMENT | обязательное поле = null |
| 66 | COUNT_LIMIT_EXCEEDED | `count > 200` в LBS |
| 67 | INVALID_NUMBER_OF_ELEMENTS | `count > 1000` в GPS |
| 175 | ACTIVE_TASK_ALREADY_EXISTS | активная задача у абонента уже есть |
| 225 | REQUEST_DATE_TIME_INCONSISTENT_FORMAT | смешаны форматы дат |

### Коды результата платного `subscriberRequests`

| Код | Смысл |
|---|---|
| 0 | success |
| 5 / 201 | абонент вне сети |
| 504 | определение заблокировано оператором |
| 510 | роуминг |
| 585 | не удаётся определить |
| 588 | превышена частота запросов |
| 595 | нет GPS |
| 906 | пользователь отозвал согласие на геолокацию |

---

## 7. Локальная интеграция в FOT

### Где что лежит

| Слой | Файл |
|---|---|
| Базовый клиент (auth, retry, лимитер) | [mts-base.service.ts](../fot-server/src/services/mts-base.service.ts) |
| Доменные методы | [mts-data.service.ts](../fot-server/src/services/mts-data.service.ts) |
| Привязка абонент↔сотрудник | [mts-mapping.service.ts](../fot-server/src/services/mts-mapping.service.ts) |
| Задачи (локальное хранилище) | [mts-tasks.service.ts](../fot-server/src/services/mts-tasks.service.ts) |
| Фоновый поллер | [mts-location-poller.service.ts](../fot-server/src/services/mts-location-poller.service.ts) |
| Контроллер | [mts.controller.ts](../fot-server/src/controllers/mts.controller.ts) |
| Роуты | [mts.routes.ts](../fot-server/src/routes/mts.routes.ts) |
| Резолв токена | [settings.service.ts → getResolvedMtsConfig](../fot-server/src/services/settings.service.ts) |
| Фронт-страница | [MtsPage.tsx](../fot-app/src/pages/mts/MtsPage.tsx) |
| React Query хуки | [useMtsData.ts](../fot-app/src/hooks/useMtsData.ts) |
| API-клиент фронта | [mtsService.ts](../fot-app/src/services/mtsService.ts) |
| Диагностический скрипт | [mts-fetch-subscribers.mjs](../fot-server/scripts/mts-fetch-subscribers.mjs) |

### REST-роуты бэка (под префиксом `/api/mts`)

| Метод | Путь | Тариф | Защита |
|---|---|---|---|
| GET | `/connection-settings` | — | view |
| PUT | `/connection-settings` | — | edit + 2FA |
| POST | `/connection-settings/test` | 🟢 | view |
| GET | `/subscribers` | 🟢 | view + data-scope |
| GET | `/subscriber-groups` | 🟢 | view |
| GET | `/subscriber-groups/:id` | 🟢 | view |
| GET | `/custom-fields` | 🟢 | view |
| GET | `/last-locations` | 🟢 | view + data-scope |
| GET | `/track` | 🟢 | view + IDOR |
| GET | `/history` | — (из БД) | view + IDOR + аудит |
| GET | `/recent-locations?days=N` | 🟢 | super_admin |
| GET | `/recent-tracks?days=N` | 🟢 | super_admin |
| GET | `/recent-global-locations?days=N` | 🟢 | super_admin |
| POST | `/request-location` | 🔴 | super_admin + 2FA + `confirmed:true` |
| GET | `/tasks`, `/tasks/:id` | 🟢 / ⚪ | view |
| POST | `/tasks` | ⚪ | edit + 2FA |
| GET / PUT | `/mappings*` | — | view / edit + 2FA |

### Параметр `days`

В `/recent-*` параметр `days` ограничен значением **1..7** на стороне бэка
([parseDaysRange](../fot-server/src/controllers/mts.controller.ts)). Этого хватает для UI;
полная выгрузка делается скриптом
[mts-fetch-subscribers.mjs](../fot-server/scripts/mts-fetch-subscribers.mjs).

### Безопасность

- `Cache-Control: no-store` на всём модуле (middleware `noStore`).
- Описания ошибок МТС не пробрасываются клиенту целиком (могут содержать ПДн).
- Доступ к странице `/mts` — только `super_admin` (миграция 108).
- Сохранение токена и привязок — под critical 2FA.
- История перемещений (`/history`) — всегда в аудите.

---

## 8. Диагностика типовых проблем

### «Подключение настроено, но абоненты не грузятся»

1. Открыть `/mts` → нажать **«Проверить подключение»**.
2. Под кнопкой появляется диагностический блок (`http`, `mtsCode`, `desc`, `message`,
   `baseUrl`, `source`, `hasToken`).
3. Сверить со сценариями ниже.

| Симптом | Причина | Лечение |
|---|---|---|
| `http=401, mtsCode=1` | токен невалидный / просрочен | перевыдать токен в ЛК M-Poisk, сохранить через UI |
| `http=401`, `source=system_settings` | расшифровка `ENCRYPTION_KEY` сломалась | перевыдать токен либо проверить env-ключ шифрования |
| `http=0, message=*MTS base URL*` | base URL не в allow-list | поставить `https://api.mpoisk.ru/v6/api` |
| `mtsCode=66` | запросили >200 элементов | пагинация по `lastLocationID` (см. `paginate()`) |
| `mtsCode=67` | запросили >1000 GPS-точек | разбить интервал на части |
| `mtsCode=225` | смешаны форматы дат | привести `dateFrom`/`dateTo` к одному формату |
| Тест ок, но `subscribers=0` | в аккаунте действительно нет абонентов | проверить через UI ЛК M-Poisk |
| Тест ок, но `Не удалось загрузить абонентов` в портале | data-scope режет всё (не-super_admin) | проверить, есть ли привязки абонент→сотрудник в его scope |

### Сверить токен через standalone-скрипт

Когда непонятно, на чьей стороне проблема — токена или БД-настройки — запустите скрипт
с тем же токеном напрямую:

```powershell
cd fot-server
node scripts/mts-fetch-subscribers.mjs --token=<JWE>
```

Скрипт делает 9 GET-запросов (все бесплатные) и пишет сырые ответы в
`fot-server/data/mts/<timestamp>/`. Если скрипт работает, а портал — нет, проблема в
`settings.service.ts` / шифровании, а не в самом токене.

### Логи бэка

Полезные строки в stderr:

```
[mts] subscribers raw payload shape: array(len=42)
[mts] upstream error: http=401 code=1
[mts] testConnection failed: http=401 code=1 desc=USER_UNAUTHORIZED msg=...
[mts-poller] tick: fetched=42 saved=12
```

---

## 9. Примеры запросов (curl)

```bash
# 1. Проверка авторизации
curl -H "Authorization: Bearer $MTS_TOKEN" \
     https://api.mpoisk.ru/v6/api/subscriberManagement/subscribers

# 2. Последние позиции
curl -H "Authorization: Bearer $MTS_TOKEN" \
     https://api.mpoisk.ru/v6/api/subscriberManagement/subscribers/lastLocations

# 3. Треки за день
curl -H "Authorization: Bearer $MTS_TOKEN" \
     "https://api.mpoisk.ru/v6/api/mobilePositioningManagement/tracks?dateFrom=2026-05-19T00:00:00&dateTo=2026-05-20T00:00:00&count=200"

# 4. ПЛАТНО — определить позицию (НЕ запускать без согласования)
curl -X POST -H "Authorization: Bearer $MTS_TOKEN" -H "Content-Type: application/json" \
     -d '{"subscriberID": 12345}' \
     https://api.mpoisk.ru/v6/api/subscriberManagement/subscriberRequests
```

---

## 10. Ссылки

- Технический контракт: [docs/mts-mobile-staff-api.md](mts-mobile-staff-api.md)
- Standalone-скрипт: [fot-server/scripts/mts-fetch-subscribers.mjs](../fot-server/scripts/mts-fetch-subscribers.mjs)
- Официальный портал: <https://developers.mts.ru/traveling-staff/>
- Help-center M-Poisk: <https://enter.mpoisk.ru/help-center/integration/api>
- Swagger UI (требует логин в ЛК): <https://api.mpoisk.ru/v6/swagger/ui/index>
- Контакт интеграций: `b2b@mpoisk.ru`
