/**
 * Точечный ANALYZE партиции skud_events_2026_05 + замер эффекта.
 *
 * Зачем: статистика партиции датирована 24.05, когда она была заполнена наполовину.
 * Из-за этого планировщик выбирает Index Scan и тратит 272 842 буфера на 297 572 строки
 * (0.917 буфера на строку) при том, что вся куча — 15 690 страниц. Соседние партиции
 * при тех же объёмах идут Seq Scan за 0.030 буфера на строку. Это 83% стоимости
 * scope-запроса табельщицы.
 *
 * ТРИ РАЗДЕЛЬНЫХ РЕЖИМА, каждый разрешается отдельно:
 *
 *   --preflight            только проверки, ничего не меняет. Можно в любое время.
 *   --apply --yes          единственная запись за весь скрипт: ANALYZE. ТОЛЬКО в непик.
 *   --measure              два EXPLAIN старого и нового SQL по контрольной табельщице.
 *                          Запускать ПОСЛЕ --apply, там же, в непик.
 *
 * Скрипт НЕ делает: миграций, VACUUM, DML, автозапуска сверки ворот A, деплоя.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd /opt/fot-build/fot-server && npx tsx scripts/analyze-skud-may-partition.ts --preflight
 *
 * Код возврата: 0 — успех; 1 — проверка не пройдена / операция не удалась;
 *               2 — ошибка вызова (не выбран режим, нет --yes и т.п.).
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPgPoolConfig } from '../src/config/postgres.js';

/** Партиция задана жёстко: никаких вычисляемых имён таблиц. */
const PARTITION = 'public.skud_events_2026_05';
const PARTITION_RELNAME = 'skud_events_2026_05';
/** Родительская партиционированная таблица — проверяем, что правим именно её партицию. */
const PARENT_RELNAME = 'skud_events';

/** Ожидаемая прод-БД. Несовпадение = подключились не туда. */
const EXPECTED_DB = 'FOT_Prod';

/**
 * statement_timeout задаём В КОНФИГЕ ПУЛА, а не через SET LOCAL: SET LOCAL действует
 * только внутри транзакции, а у отдельного ANALYZE её нет — лимит остался бы прежним (30 с).
 */
const STATEMENT_TIMEOUT_MS = 180_000;

/** ANALYZE берёт ShareUpdateExclusiveLock и может ждать конфликтующую операцию. */
const LOCK_TIMEOUT_MS = 15_000;

/**
 * Опции EXPLAIN вынесены в константу и печатаются в отчёте: замер «после» обязан
 * сниматься ровно теми же опциями, что и эталон «до», иначе цифры несопоставимы.
 * Эталоны 13.08 снимались с TIMING OFF (у нового запроса дополнительно стоял
 * COSTS OFF — он косметический и на Execution Time не влияет).
 */
const EXPLAIN_OPTIONS = 'ANALYZE, BUFFERS, TIMING OFF';

/** Насколько свежим должен быть last_analyze, чтобы --measure имел смысл. */
const MAX_ANALYZE_AGE_MS = 24 * 60 * 60 * 1000;

/** Контрольная табельщица, на которой сняты эталоны «до». Другая сделает сравнение бессмысленным. */
const DEFAULT_CONTROL_USER = '2b194963-380b-4607-9ca7-7984d6c8e40c';

/** Эталоны «до» (13.08, EXPLAIN на проде) — для печати рядом с новым замером. */
const BASELINE = {
  old: { ms: 11_711, buffers: 311_239 },
  neu: { ms: 28_125, buffers: 330_363 },
};

const PRESENCE_WINDOW_DAYS = 90;
const LI_OBSHESTROY_DEPARTMENT_ID = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';

/**
 * Узкий интерфейс исполнителя SQL: позволяет подменить клиент в тестах.
 * PoolClient оборачивается лямбдой в main() — так не зависим от его перегрузок.
 */
export interface ISqlRunner {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

export interface IPreflightRow {
  db: string;
  current_user_name: string;
  in_recovery: boolean;
  partition_exists: boolean;
  is_partition: boolean;
  parent_relname: string | null;
  partition_owner: string | null;
  is_owner: boolean;
  has_maintain: boolean;
  last_analyze: string | null;
  last_autoanalyze: string | null;
  correlation: number | null;
}

export interface IVerdict {
  ok: boolean;
  problems: string[];
}

/** Проверки, общие для всех режимов: та ли БД, та ли партиция, не реплика. */
function checkEnvironment(row: IPreflightRow): string[] {
  const problems: string[] = [];
  if (row.db !== EXPECTED_DB) {
    problems.push(`подключение к БД "${row.db}", ожидалась "${EXPECTED_DB}"`);
  }
  if (row.in_recovery) {
    problems.push('сервер в recovery (реплика)');
  }
  if (!row.partition_exists) {
    problems.push(`отношение ${PARTITION} не найдено`);
    return problems;
  }
  // Существования отношения мало: опечатка в имени могла бы указать на постороннюю
  // таблицу с подходящими правами. Проверяем, что это партиция именно skud_events.
  if (!row.is_partition) {
    problems.push(`${PARTITION} существует, но не является партицией`);
  } else if (row.parent_relname !== PARENT_RELNAME) {
    problems.push(
      `${PARTITION} — партиция "${row.parent_relname ?? '?'}", ожидалась "${PARENT_RELNAME}"`,
    );
  }
  return problems;
}

/**
 * Допуск к ANALYZE. Чистая функция — вся логика без обращения к БД, чтобы её можно
 * было покрыть тестами. «Приложение ходит под владельцем партиции» — гипотеза,
 * которую подтверждает или опровергает именно этот шаг, на том же соединении.
 */
export function evaluatePreflight(row: IPreflightRow | undefined): IVerdict {
  if (!row) return { ok: false, problems: ['preflight-запрос не вернул строк'] };

  const problems = checkEnvironment(row);
  if (!row.is_owner && !row.has_maintain) {
    problems.push(
      `роль "${row.current_user_name}" не владеет ${PARTITION} (владелец: ${row.partition_owner ?? '?'})` +
      ' и не имеет MAINTAIN — ANALYZE будет отклонён',
    );
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Допуск к замеру. Прав на ANALYZE не требует, но требует правильного окружения
 * И свежего last_analyze: иначе замер молча выдал бы цифры «до», выдав их за «после».
 */
export function evaluateMeasureReadiness(
  row: IPreflightRow | undefined,
  nowMs: number,
  maxAgeMs: number = MAX_ANALYZE_AGE_MS,
): IVerdict {
  if (!row) return { ok: false, problems: ['preflight-запрос не вернул строк'] };

  const problems = checkEnvironment(row);
  if (!row.last_analyze) {
    problems.push('last_analyze пуст — ANALYZE ещё не выполнялся, замерять нечего');
  } else {
    const ageMs = nowMs - Date.parse(row.last_analyze);
    if (Number.isNaN(ageMs)) {
      problems.push(`не удалось разобрать last_analyze: "${row.last_analyze}"`);
    } else if (ageMs > maxAgeMs) {
      const hours = Math.round(ageMs / 3_600_000);
      problems.push(`last_analyze устарел (${hours} ч назад) — сначала выполните --apply --yes`);
    }
  }
  return { ok: problems.length === 0, problems };
}

const PREFLIGHT_SQL = `
  SELECT current_database()                                   AS db,
         current_user::text                                   AS current_user_name,
         pg_is_in_recovery()                                  AS in_recovery,
         (c.oid IS NOT NULL)                                  AS partition_exists,
         COALESCE(c.relispartition, false)                    AS is_partition,
         (SELECT p.relname FROM pg_inherits i
            JOIN pg_class p ON p.oid = i.inhparent
           WHERE i.inhrelid = c.oid)                          AS parent_relname,
         pg_get_userbyid(c.relowner)                          AS partition_owner,
         COALESCE(pg_has_role(current_user, c.relowner, 'USAGE'), false) AS is_owner,
         COALESCE(has_table_privilege(current_user, c.oid, 'MAINTAIN'), false) AS has_maintain,
         s.last_analyze::text                                 AS last_analyze,
         s.last_autoanalyze::text                             AS last_autoanalyze,
         st.correlation                                       AS correlation
    FROM (SELECT 1) dummy
    LEFT JOIN pg_class c ON c.oid = to_regclass($1::text)
    LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
    LEFT JOIN pg_stats st ON st.schemaname = 'public'
                         AND st.tablename = $2
                         AND st.attname = 'event_date'`;

async function fetchPreflightRow(runner: ISqlRunner): Promise<IPreflightRow | undefined> {
  const { rows } = await runner.query(PREFLIGHT_SQL, [PARTITION, PARTITION_RELNAME]);
  return rows[0] as IPreflightRow | undefined;
}

function printPreflight(row: IPreflightRow): void {
  console.log('--- Preflight ---');
  console.log(`  БД:                  ${row.db} (ожидалась ${EXPECTED_DB})`);
  console.log(`  Подключён как:       ${row.current_user_name}`);
  console.log(`  Владелец партиции:   ${row.partition_owner ?? '—'}`);
  console.log(`  Владение / MAINTAIN: ${row.is_owner} / ${row.has_maintain}`);
  console.log(`  Реплика (recovery):  ${row.in_recovery}`);
  console.log(`  Отношение найдено:   ${row.partition_exists}`);
  console.log(`  Партиция таблицы:    ${row.parent_relname ?? '—'} (relispartition=${row.is_partition})`);
  console.log(`  last_analyze:        ${row.last_analyze ?? '—'}`);
  console.log(`  last_autoanalyze:    ${row.last_autoanalyze ?? '—'}`);
  console.log(`  correlation(event_date): ${row.correlation ?? '—'}`);
}

function printProblems(title: string, problems: string[]): void {
  console.error(`${title}:`);
  for (const problem of problems) console.error(`  - ${problem}`);
}

async function runPreflight(runner: ISqlRunner): Promise<number> {
  const row = await fetchPreflightRow(runner);
  if (row) printPreflight(row);
  const verdict = evaluatePreflight(row);
  if (!verdict.ok) {
    printProblems('Preflight НЕ пройден', verdict.problems);
    return 1;
  }
  console.log('Preflight пройден: ANALYZE выполнить можно.');
  return 0;
}

// ─── Apply ────────────────────────────────────────────────────────────────────

const LAST_ANALYZE_SQL =
  'SELECT last_analyze::text AS last_analyze FROM pg_stat_user_tables WHERE relid = to_regclass($1::text)';

/** Экспортируется ради mock-тестов: единственная запись скрипта должна быть проверяема. */
export async function runApply(runner: ISqlRunner): Promise<number> {
  const row = await fetchPreflightRow(runner);
  if (row) printPreflight(row);
  const verdict = evaluatePreflight(row);
  if (!verdict.ok) {
    printProblems('ANALYZE не выполняется, preflight НЕ пройден', verdict.problems);
    return 1;
  }

  const lastAnalyzeBefore = row?.last_analyze ?? null;

  // Зависший ANALYZE на проде хуже, чем неудачный: ждём блокировку ограниченное время.
  await runner.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);

  console.log(`\nВыполняю ANALYZE ${PARTITION} ...`);
  const startedAt = Date.now();
  try {
    await runner.query(`ANALYZE ${PARTITION}`);
  } catch (error) {
    console.error(`ANALYZE не удался: ${(error as Error).message}`);
    return 1;
  }
  console.log(`ANALYZE завершён за ${Date.now() - startedAt} мс.`);

  // Факт выполнения подтверждаем данными, а не отсутствием исключения.
  const after = await runner.query(LAST_ANALYZE_SQL, [PARTITION]);
  const lastAnalyzeAfter = (after.rows[0] as { last_analyze: string | null } | undefined)?.last_analyze ?? null;
  console.log(`  last_analyze: ${lastAnalyzeBefore ?? '—'} → ${lastAnalyzeAfter ?? '—'}`);

  if (!lastAnalyzeAfter || lastAnalyzeAfter === lastAnalyzeBefore) {
    console.error('last_analyze не изменился — считаю операцию неуспешной.');
    return 1;
  }

  console.log('\nГотово. Следующий шаг — отдельный запуск с --measure.');
  return 0;
}

// ─── Measure ──────────────────────────────────────────────────────────────────

/**
 * Старый прод-путь состоял из ДВУХ statement'ов: сначала отдельно читались папки,
 * затем тяжёлый запрос получал готовый массив $2::uuid[]. Собрать папки внутри CTE
 * через array_agg — это другой план, и сравнение с эталоном стало бы недействительным.
 * Тексты дословно повторяют verify-timekeeper-scope-equivalence.ts (экспортировать их
 * оттуда нельзя — это изменило бы замороженный релизный коммит).
 */
export const OLD_FOLDERS_SQL = `
  SELECT department_id FROM timekeeper_folder_access
   WHERE timekeeper_user_id = $1::uuid AND is_active = true`;

export const OLD_SEEDS_SQL = `
  WITH folder_desc AS (
    SELECT id FROM public.get_descendant_department_ids($2::uuid[])
  ),
  present AS (
    SELECT DISTINCT eda.department_id AS id
      FROM timekeeper_object_access toa
      JOIN employee_skud_object_access esoa
        ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
      JOIN employee_department_access eda
        ON eda.employee_id = esoa.employee_id AND eda.is_active = true
     WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
    UNION
    SELECT DISTINCT eda.department_id AS id
      FROM timekeeper_object_access toa
      JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
      JOIN skud_events se
        ON BTRIM(se.access_point) = BTRIM(sap.access_point_name)
       AND se.event_date >= (CURRENT_DATE - INTERVAL '${PRESENCE_WINDOW_DAYS} days')
      JOIN employee_department_access eda
        ON eda.employee_id = se.employee_id AND eda.is_active = true
     WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
  )
  SELECT p.id
    FROM present p
    JOIN org_departments d ON d.id = p.id
   WHERE p.id IN (SELECT id FROM folder_desc)
     AND (
       d.kind = 'brigade'
       OR (
         d.kind = 'department'
         AND d.is_active = true
         AND d.id <> $3::uuid
         AND NOT EXISTS (
           SELECT 1 FROM org_departments c
            WHERE c.parent_id = d.id AND c.is_active = true
         )
       )
     )`;

export interface IExplainResult {
  ms: number | null;
  hit: number | null;
  read: number | null;
}

/**
 * Разбор хвоста EXPLAIN: буферы КОРНЯ (первая строка Buffers) и Execution Time.
 * shared read учитывается наравне с hit — при холодном кэше он и есть основная стоимость.
 */
export function parseExplain(lines: string[]): IExplainResult {
  let hit: number | null = null;
  let read: number | null = null;
  let ms: number | null = null;
  for (const line of lines) {
    if (hit === null && read === null) {
      const buffers = /Buffers: shared(?: hit=(\d+))?(?: read=(\d+))?/.exec(line);
      if (buffers && (buffers[1] !== undefined || buffers[2] !== undefined)) {
        hit = buffers[1] !== undefined ? Number(buffers[1]) : 0;
        read = buffers[2] !== undefined ? Number(buffers[2]) : 0;
      }
    }
    const exec = /Execution Time: ([\d.]+) ms/.exec(line);
    if (exec) ms = Number(exec[1]);
  }
  return { ms, hit, read };
}

export const totalBuffers = (r: IExplainResult): number | null =>
  r.hit === null || r.read === null ? null : r.hit + r.read;

async function explain(runner: ISqlRunner, sql: string, params: unknown[]): Promise<IExplainResult> {
  const { rows } = await runner.query(`EXPLAIN (${EXPLAIN_OPTIONS}) ${sql}`, params);
  return parseExplain((rows as Array<{ 'QUERY PLAN': string }>).map(r => r['QUERY PLAN']));
}

async function runMeasure(runner: ISqlRunner, userId: string): Promise<number> {
  const row = await fetchPreflightRow(runner);
  if (row) printPreflight(row);
  const verdict = evaluateMeasureReadiness(row, Date.now());
  if (!verdict.ok) {
    printProblems('Замер НЕ выполняется', verdict.problems);
    return 1;
  }

  // Новый SQL берём из сервиса, а не копией: замеряем то, что поедет на прод.
  const { TIMEKEEPER_SCOPE_SNAPSHOT_SQL } = await import('../src/services/timekeeper-scope.service.js');

  console.log(`\nКонтрольная табельщица: ${userId}`);
  console.log(`Опции EXPLAIN: (${EXPLAIN_OPTIONS})\n`);

  // Старый путь воспроизводим целиком: сначала папки отдельным запросом.
  const folders = await runner.query(OLD_FOLDERS_SQL, [userId]);
  const folderIds = [...new Set((folders.rows as Array<{ department_id: string }>).map(r => r.department_id))];
  if (folderIds.length === 0) {
    console.error('У контрольной табельщицы нет активных папок — старый путь возвращал []');
    console.error('без тяжёлого запроса, сравнивать нечего. Укажите другого --user.');
    return 1;
  }

  console.log('Старый seeds-запрос ...');
  const oldRes = await explain(runner, OLD_SEEDS_SQL, [userId, folderIds, LI_OBSHESTROY_DEPARTMENT_ID]);
  console.log('Новый объединённый statement ...');
  const newRes = await explain(runner, TIMEKEEPER_SCOPE_SNAPSHOT_SQL, [userId, LI_OBSHESTROY_DEPARTMENT_ID]);

  // Молчаливый прочерк вместо числа — это непройденный замер, а не успех.
  for (const [label, res] of [['старый', oldRes], ['новый', newRes]] as const) {
    if (res.ms === null || totalBuffers(res) === null) {
      console.error(`Не удалось разобрать вывод EXPLAIN для запроса «${label}»: ` +
        `ms=${res.ms}, hit=${res.hit}, read=${res.read}`);
      return 1;
    }
  }

  const n = (v: number | null) => (v === null ? '—' : v.toLocaleString('ru-RU'));
  console.log('\n--- Результат ---');
  console.log(`                       было (13.08)   стало`);
  console.log(`  старый, мс:          ${n(BASELINE.old.ms).padEnd(14)} ${n(oldRes.ms)}`);
  console.log(`  старый, буферов:     ${n(BASELINE.old.buffers).padEnd(14)} ${n(totalBuffers(oldRes))}` +
    `  (hit ${n(oldRes.hit)} + read ${n(oldRes.read)})`);
  console.log(`  новый,  мс:          ${n(BASELINE.neu.ms).padEnd(14)} ${n(newRes.ms)}`);
  console.log(`  новый,  буферов:     ${n(BASELINE.neu.buffers).padEnd(14)} ${n(totalBuffers(newRes))}` +
    `  (hit ${n(newRes.hit)} + read ${n(newRes.read)})`);

  console.log('\nРешение принимается по ФАКТИЧЕСКОМУ ВРЕМЕНИ, а не по смене Index Scan → Seq Scan:');
  console.log('  - старый уже достаточно быстрый  → код не деплоить автоматически;');
  console.log('  - новый не быстрее старого       → код не деплоить;');
  console.log('  - новый в диапазоне 2.5–6 с      → отдельное решение перед деплоем;');
  console.log('  - план не изменился вовсе        → остановиться, гипотеза о статистике неверна.');
  return 0;
}

// ─── main ─────────────────────────────────────────────────────────────────────

const arg = (name: string): string | null => {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

async function main(): Promise<number> {
  const wantPreflight = process.argv.includes('--preflight');
  const wantApply = process.argv.includes('--apply');
  const wantMeasure = process.argv.includes('--measure');

  const modes = [wantPreflight, wantApply, wantMeasure].filter(Boolean).length;
  if (modes !== 1) {
    console.error('Укажите РОВНО один режим: --preflight | --apply --yes | --measure');
    return 2;
  }
  if (wantApply && !process.argv.includes('--yes')) {
    console.error('--apply выполняет ANALYZE на production. Подтвердите вторым флагом --yes.');
    console.error('Запускать только в непиковое время.');
    return 2;
  }

  const pool = new Pool(createPgPoolConfig({
    max: 1,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    application_name: 'fot-analyze-skud-may',
  }));
  const client = await pool.connect();
  const runner: ISqlRunner = { query: (sql, params) => client.query(sql, params) };

  try {
    if (wantPreflight) return await runPreflight(runner);
    if (wantApply) return await runApply(runner);
    return await runMeasure(runner, arg('user') ?? DEFAULT_CONTROL_USER);
  } finally {
    // release(true) уничтожает соединение: изменённые session-параметры
    // (lock_timeout) не должны вернуться в пул.
    client.release(true);
    await pool.end();
  }
}

// Запускаем main() только при прямом вызове файла. Без этого гарда юнит-тест,
// импортирующий чистые функции, полез бы в БД на этапе импорта.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error('[analyze-skud-may] упал:', error);
      process.exit(1);
    });
}
