# МТС «Мобильные сотрудники» (M-Poisk) REST API — контракт интеграции

> Артефакт Фазы 0 плана `api-polished-beaver`. Источник: публичный help-center
> `https://enter.mpoisk.ru/help-center/integration/api/*` + живой Swagger UI
> `https://api.mpoisk.ru/v6/swagger/ui/index`. Портал МТС
> `developers.mts.ru/traveling-staff` — это re-skin того же сервиса M-Poisk
> (сервис старше бренда МТС). Уточнять enum-значения и точные числовые квоты —
> по аутентифицированному Swagger в ЛК пользователя или у `b2b@mpoisk.ru`.

## Base URL и версия

- Host: `api.mpoisk.ru`
- Base: **`https://api.mpoisk.ru/v6/api/`**
- Swagger UI (требует логин для spec JSON): `https://api.mpoisk.ru/v6/swagger/ui/index`

## Аутентификация

- Токен создаётся в веб-ЛК: профиль → Настройки → вкладка «Интеграция по API» →
  «Создать токен» → подтверждение SMS-кодом (действует 5 мин). Токен показывается
  один раз — сохранить сразу.
- Заголовок на каждый запрос: `Authorization: Bearer <token>`
- Формат токена: JWE (`alg: ECDH-ES+A256KW`, `enc: A256CBC-HS512`) — для нас это
  непрозрачная строка.
- Content-Type: `application/json`.
- Дата-время: ISO local `2021-01-07T00:00:00`, UTC `...Z` или offset `...+03:00`.
  **Нельзя смешивать форматы в одном запросе** → код `225`.

## Идентификаторы

- Абонент (сотрудник): `subscriberID` (integer). Внешняя ссылка: `externalID`
  (в вебхуках — `subscriberExternalID`). **Ключ привязки к `employees.id`** —
  через нашу таблицу `mts_subscriber_map` по `subscriberID`; `externalID` можно
  использовать для авто-сопоставления, если бизнес его проставит.
- Задача: `taskID` (integer).

## Эндпоинты (используемые модулем)

### Абоненты — `/v6/api/subscriberManagement/...`

| Метод | Путь | Назначение |
|---|---|---|
| GET | `subscribers` | список абонентов |
| GET | `subscribers/{subscriberID}` | один абонент |
| GET | `subscribers/externalID/{externalID}` | абонент по внешнему id |
| GET | `subscribers/lastLocations` | последние известные позиции |
| POST | `subscriberRequests` | запросить определение местоположения |
| GET/POST | `subscriberGroups`, `subscriberGroups/{id}` | группы |

Фильтры `subscribers`: `isActive, subscriberIDs, subscriberGroupIDs, dateFrom,
dateTo, withCustomTemplateItems`. Поля ответа: `subscriberID, name, phone,
subscriberTariffTypeID, canTrack, isOnline, isLocateEnabled, longitude,
latitude, radius`.

### Мобильное позиционирование (LBS) — `/v6/api/mobilePositioningManagement/...`

| Метод | Путь | Параметры |
|---|---|---|
| GET | `locations` | `dateFrom, dateTo, subscriberIDs, count, offset, lastLocationID` |
| GET | `locations/{locationID}` | — |
| GET | `tracks` | `dateFrom, dateTo, subscriberIDs, count, lastTrackID` |

Location: `locationDate, subscriberID, state, source, locationID, requestDate,
address, longitude, latitude`. Track: `trackID, subscriberID, startDate,
finishDate, startAddress, finishAddress, startLon, startLat, finishLon,
finishLat, distance, duration`.

### Глобальное позиционирование (GPS) — `/v6/api/globalPositioningManagement/...`

`GET locations` (`dateFrom, dateTo, subscriberIDs, count ≤ 1000,
lastLocationID`). Поля: `locationDate, subscriberID, locationID, isValid,
longitude, latitude, angle, velocity`.

### Задачи — `/v6/api/taskManagement/...` (Фаза 3)

| Метод | Путь |
|---|---|
| POST | `taskManagement/tasks` (создание) |
| GET | `taskManagement/tasks/{taskID}` (получение) |

Обязательные поля создания: `title`, `startDate`. Остальные опциональны
(`subscriberID, deadline, description, address, longitude, latitude, externalID,
clientName, clientPhone, priority, status, taskTypeID, ...`). Ответ добавляет
`creationDate`, `routeItems[]`, checklist-поля.

### Прочие группы ресурсов (вне текущего скоупа)

`vehicleManagement, sensorManagement, mapObjectManagement, zoneManagement,
formManagement, checklistsManagement, planningManagement, jobManagement,
userManagement, messageManagement, regionManagement, terminalManagement,
customFieldsManagement, customerManagement` и др.

## Конверт ошибки

```json
{ "status": 400, "code": 2, "description": "BAD_REQUEST", "message": "...", "validationErrors": {} }
```

`status` — HTTP-код, `code` — функциональный код (см. ниже).

## Коды результатов (выборка, полная таблица в help-center/result-codes)

- HTTP: 200, 201, 204, 301/302, 400, 401, 403, 404, 405, 500–504.
- Функциональные: `0 OK`, `1 USER_UNAUTHORIZED`, `2 BAD_REQUEST`,
  `3 INTERNAL_SERVER_ERROR`, `4 SUBSCRIBER_EXTERNAL_ID_EXISTS`,
  `12 NO_SUCH_SUBSCRIBER`, `18 TASK_NOT_FOUND`, `22 TITLE_IS_NEEDED`,
  `33 INVALID_TASK_START_DATE`, `50 TASKS_NOT_FOUND`, `52 NULL_ARGUMENT`,
  `66 COUNT_LIMIT_EXCEEDED` (макс 200 элементов), `67 INVALID_NUMBER_OF_ELEMENTS`
  (макс 1000), `175 ACTIVE_TASK_ALREADY_EXISTS`,
  `225 REQUEST_DATE_TIME_INCONSISTENT_FORMAT`.
- Коды запроса локации: `0` success, `5/201` вне сети, `504` заблокировано,
  `510` роуминг, `585` не определить, `588` превышена частота запросов,
  `595` нет GPS, `906` пользователь отозвал согласие на геолокацию.

## Лимиты

Явных req/сек квот публично нет. Неявные: ≤200 элементов в выборке (код 66),
≤1000 (код 67), суточный лимит планирования (`REQUEST_LIMIT_EXCEEDED`),
лимит частоты запросов локации на абонента (код 588). Интервал поллера и
кэш-TTL подбираем консервативно (≥60 c), пагинация порциями ≤200.

## Открытые вопросы (уточнить по аутентифицированному Swagger / у вендора)

- Точные числовые квоты req/сек/сутки.
- Полные значения enum: `status`, `priority`, `commentPolicy`, `taskTypeID`,
  location `state`/`source`.
- Наличие sandbox/test base URL.
- Формат пагинации списка абонентов (offset vs cursor `lastLocationID`-стиль).
