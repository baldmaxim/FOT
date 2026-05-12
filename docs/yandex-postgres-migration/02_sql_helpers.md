# 02 — Минимальный SQL toolkit (замена supabase.from / supabase.rpc)

## Зачем

После миграции Supabase Cloud → Yandex Managed PostgreSQL бэкенд не сможет
больше ходить через `supabase-js` (нет PostgREST, нет `service_role`). Нужен
тонкий слой поверх обычного PostgreSQL-клиента (`pg`, `postgres.js` — что
выберем).

Этот модуль:

- НЕ воспроизводит Supabase-like fluent builder.
- НЕ принимает имена таблиц/колонок из request без allowlist.
- ВСЕГДА подставляет значения через параметры `$1, $2, ...` — никакой
  конкатенации пользовательских значений в SQL.

Файлы:

- `fot-server/src/db/sql.ts` — чистые функции-helpers, без I/O.
- `fot-server/src/db/repositories/base.repository.ts` — тонкая база
  репозитория, использует helpers + любой PostgreSQL executor с
  `query(sql, params)`.
- `fot-server/src/db/sql.test.ts` / `base.repository.test.ts` — unit-тесты.

## API `sql.ts`

### `isValidIdentifier(name): boolean` / `identifier(name, allowlist?): string`

Валидирует имя по regex `^[A-Za-z_][A-Za-z0-9_]*$` (≤ 63 символа) и опционально
проверяет allowlist. Возвращает имя в двойных кавычках.

```ts
identifier('users');                 // → '"users"'
identifier('name', ['id', 'name']);  // → '"name"'
identifier('pwd', ['id', 'name']);   // throws: not in allowlist
identifier('1abc');                  // throws: Invalid SQL identifier
```

### `buildInsert(table, row, { allowedColumns, returning? })`

Один INSERT с позиционными параметрами и опциональным RETURNING.

```ts
const f = buildInsert('users', { name: 'Alice', email: 'a@x' }, {
  allowedColumns: ['id', 'name', 'email'],
  returning: '*',
});
// f.sql    = INSERT INTO "users" ("name", "email") VALUES ($1, $2) RETURNING *
// f.params = ['Alice', 'a@x']
```

### `buildBulkInsert(table, rows, { allowedColumns, returning? })`

Bulk INSERT нескольких строк. Все строки должны иметь одинаковый набор
колонок (заданный первой строкой) — гетерогенные строки отклоняются.
Параметры нумеруются сквозным образом.

```ts
buildBulkInsert('events', [{ a: 1 }, { a: 2 }], { allowedColumns: ['a'] });
// → INSERT INTO "events" ("a") VALUES ($1), ($2)
```

### `buildUpdate(table, set, where, { allowedSetColumns, allowedWhereColumns, returning? })`

UPDATE с раздельными allowlist'ами для SET и WHERE. `null` в WHERE
рендерится как `IS NULL` (без параметра). Пустой WHERE отклоняется
явно — защита от случайного апдейта всей таблицы.

```ts
buildUpdate(
  'users',
  { name: 'New', email: null },
  { id: 42 },
  { allowedSetColumns: ['name', 'email'], allowedWhereColumns: ['id'] },
);
// UPDATE "users" SET "name" = $1, "email" = $2 WHERE "id" = $3
```

### `buildOrderBy(items, allowedColumns): string`

```ts
buildOrderBy(
  [{ column: 'created_at', direction: 'desc', nulls: 'last' }, { column: 'id' }],
  ['id', 'created_at'],
);
// → ORDER BY "created_at" DESC NULLS LAST, "id" ASC
```

### `buildLimitOffset(limit?, offset?): string`

Целые числа, `limit ≤ 100000`. Числа инлайнятся в SQL после строгой
валидации `Number.isInteger`.

```ts
buildLimitOffset(50, 100); // → 'LIMIT 50 OFFSET 100'
buildLimitOffset();         // → ''
```

### `buildSupabaseRange(from, to): { limit, offset }`

Конвертирует Supabase-style **inclusive** `.range(from, to)` в обычные
`LIMIT/OFFSET`.

```ts
buildSupabaseRange(0, 24);  // → { limit: 25, offset: 0 }
buildSupabaseRange(50, 99); // → { limit: 50, offset: 50 }
```

### `inClause(values, paramStart): ISqlFragment`

`IN ($N, $N+1, ...)` для встроенной интеграции в hand-written queries.
Бросает на пустой массив (пустой `IN ()` — невалидный SQL).

```ts
const r = inClause([10, 20, 30], 5);
// r.sql    = 'IN ($5, $6, $7)'
// r.params = [10, 20, 30]
```

### `anyClause(values, paramStart): ISqlFragment`

`= ANY($N)` — единственный array-параметр. Безопасен на пустом
массиве (матчит ноль строк, не падает). Используется как
fault-tolerant альтернатива `inClause`.

```ts
const r = anyClause([1, 2, 3], 4);
// r.sql    = '= ANY($4)'
// r.params = [[1, 2, 3]]
```

### `jsonbParam(value): string`

`JSON.stringify(value)`. Использовать вместе с явным `::jsonb` cast
в SQL.

```ts
const j = jsonbParam([{ emp_id: 1, date: '2026-05-11' }]);
// → '[{"emp_id":1,"date":"2026-05-11"}]'
// SQL: SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)
// params: [j]
```

### `normalizePgError(err): IPgErrorInfo`

Нормализует ошибку pg-драйвера (или произвольного исключения) в стабильный
объект `{ code, message, detail?, hint?, table?, column?, constraint?, schema? }`.

## API `base.repository.ts`

### Контракт executor'а

```ts
interface ISqlExecutor {
  query<TRow>(sql: string, params: readonly unknown[]): Promise<{
    rows: TRow[];
    rowCount?: number | null;
  }>;
}
```

Подходит под `pg.Pool`, `pg.Client`, обёртки над `postgres.js` и т. п.

### `BaseRepository`

Сабкласс задаёт имя таблицы и allowlist колонок:

```ts
class UsersRepo extends BaseRepository {
  constructor(executor: ISqlExecutor) {
    super({
      table: 'users',
      allowedColumns: ['id', 'name', 'email', 'created_at'],
      executor,
    });
  }
}
```

Доступные методы:

| Метод | Назначение |
|---|---|
| `findMany({ where?, columns?, orderBy?, limit?, offset? })` | SELECT с allowlist-проверкой |
| `findOne(opts)` | Первая строка или `null` (`LIMIT 1`) |
| `insertOne(row, returning?)` | Один INSERT, возвращает строку или `null` |
| `insertMany(rows, returning?)` | Bulk INSERT, пустой массив → no-op |
| `updateWhere(set, where, returning?)` | UPDATE с обязательным WHERE |

WHERE поддерживает только равенство (`=`) и `IS NULL`. Сложные предикаты
(BETWEEN, ILIKE, JOIN, sub-select) сабклассы пишут вручную, импортируя
helpers из `sql.ts` напрямую.

Ошибки PG автоматически оборачиваются в `RepositoryError`:

```ts
try {
  await repo.insertOne({ email: 'duplicate@x' });
} catch (err) {
  if (err instanceof RepositoryError && err.code === '23505') {
    // unique violation — обработать
  }
}
```

## Правила использования

1. **Allowlist — не опциональный.** Каждый репозиторий обязан перечислить
   разрешённые колонки в конструкторе. Никаких `'*'`-allowlist'ов из
   request'а.
2. **Имена из request не доходят до SQL.** Маппинг
   `req.body.sortBy → "created_at"` делается явно в контроллере через
   `switch`/`Record<string, AllowedColumn>`. Никаких прямых
   `req.body.column → identifier(...)`.
3. **Сложный SQL — вручную.** Если не помещается в findMany/insertOne и
   т. п. — пишите SQL в сабклассе как строку, используя helpers
   (`identifier`, `inClause`, `anyClause`, `jsonbParam`,
   `buildSupabaseRange`).
4. **WHERE обязателен в UPDATE/DELETE.** `buildUpdate` отказывается
   обновлять всю таблицу. DELETE сабклассы пишут вручную с тем же
   правилом.
5. **`buildSupabaseRange` — для перехода со старого кода.** В новом коде
   используйте `buildLimitOffset` напрямую с offset-based пагинацией.

## Тесты

```bash
cd fot-server
npm run test -- src/db
```

Покрытие:

- `src/db/sql.test.ts` — все helpers, включая edge-cases (пустые
  массивы, невалидные идентификаторы, опасные значения).
- `src/db/repositories/base.repository.test.ts` — BaseRepository через
  mock executor, в т. ч. allowlist-проверки, обработка ошибок PG и
  отказ от пустого WHERE.

## Дальнейшие шаги (вне этого PR)

- Выбрать клиент PG (`pg` vs `postgres.js`) и реализовать `ISqlExecutor`
  как adapter поверх него (`fot-server/src/db/executor.ts`).
- Заменить `supabase.from(...)` в контроллерах/сервисах на конкретные
  репозитории. Начинать с простых таблиц (`settings`, `notifications`,
  `daily_tasks`); сложные (`skud_events`, `employees`) — после.
- Заменить `supabase.rpc(...)` на `executor.query('SELECT
  public.<rpc>(...)', [...])` — RPC `data_api_list_public_schema`,
  `get_descendant_department_ids` и т. п. остаются как функции, только
  способ вызова меняется.
