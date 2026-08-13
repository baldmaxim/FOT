/**
 * ВОРОТА A: доказательство эквивалентности старого и нового скоупа табельщицы.
 *
 * Старый SQL (две отдельные пары запросов) и новый объединённый statement выполняются
 * ДЛЯ ОДНОГО И ТОГО ЖЕ пользователя внутри ОДНОЙ короткой транзакции
 * REPEATABLE READ READ ONLY — иначе события СКУД, приехавшие между замерами, дали бы
 * ложное расхождение. На каждую табельщицу своя транзакция: один длинный снимок на весь
 * прогон подвешивал бы горизонт очистки и мешал автовакууму на skud_events.
 *
 * Скрипт строго read-only: только SELECT, транзакции закрываются ROLLBACK.
 *
 * ВАЖНО: старый запрос идёт по 12–15 с (на пике до 30 с) и сам по себе способен
 * положить прод. Запускать ТОЛЬКО в непиковое время или на реплике, последовательно.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server && npx tsx scripts/verify-timekeeper-scope-equivalence.ts --yes
 *   ... --user=<uuid>   — только один пользователь (осторожный первый прогон)
 *   ... --limit=2       — только первые N табельщиц
 *   ... --expect=6      — сколько табельщиц ожидается в БД (по умолчанию 6)
 *
 * Пустая выборка НЕ считается успехом: скрипт-проверка, молча возвращающий «всё ок»
 * на нуле сверок, опаснее отсутствия проверки. Ворота снимает ТОЛЬКО полный прогон
 * (без --user и --limit) при совпадении числа найденных табельщиц с --expect.
 *
 * Код возврата: 0 — полный прогон, расхождений нет, деплой по этому критерию разрешён;
 *               1 — расхождение, пустая/неполная выборка или частичный прогон;
 *               2 — ошибка вызова (нет --yes, некорректный --expect).
 */
import { getPool } from '../src/config/postgres.js';
import {
  LI_OBSHESTROY_DEPARTMENT_ID,
  TIMEKEEPER_PRESENCE_WINDOW_DAYS,
  TIMEKEEPER_SCOPE_SNAPSHOT_SQL,
  parseTimekeeperScopeRows,
  type ITimekeeperScopeRow,
} from '../src/services/timekeeper-scope.service.js';
import type { PoolClient } from 'pg';

// Новый SQL и его разбор берутся ИЗ САМОГО СЕРВИСА, а не копируются: иначе сверка
// доказывала бы эквивалентность копии, а не того кода, который поедет на прод.
const PRESENCE_WINDOW_DAYS = TIMEKEEPER_PRESENCE_WINDOW_DAYS;
/** Старый запрос легко упирается в общий statement_timeout 30 с — на время сверки поднимаем. */
const VERIFY_STATEMENT_TIMEOUT_MS = 180_000;
/** Сколько табельщиц ожидается в проде (на 13.08 — 6). Расхождение = выборка сломалась. */
const DEFAULT_EXPECTED_TIMEKEEPERS = 6;

// ─── СТАРЫЕ запросы: скопированы из timekeeper-scope.service.ts до правки ──────

const OLD_FOLDERS_SQL = `
  SELECT department_id FROM timekeeper_folder_access
   WHERE timekeeper_user_id = $1::uuid AND is_active = true`;

const OLD_SEEDS_SQL = `
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

const OLD_DIRECT_SQL = `
  SELECT DISTINCT u.employee_id FROM (
    SELECT eoa.employee_id
      FROM timekeeper_object_access toa
      JOIN employee_object_assignment eoa
        ON eoa.skud_object_id = toa.skud_object_id AND eoa.is_active = true
     WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
    UNION
    SELECT esoa.employee_id
      FROM timekeeper_object_access toa
      JOIN employee_skud_object_access esoa
        ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
     WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
    UNION
    SELECT se.employee_id
      FROM timekeeper_object_access toa
      JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
      JOIN skud_events se
        ON BTRIM(se.access_point) = BTRIM(sap.access_point_name)
       AND se.event_date >= (CURRENT_DATE - INTERVAL '${PRESENCE_WINDOW_DAYS} days')
     WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
  ) u`;

const SUBTREE_SQL = 'SELECT id FROM public.get_descendant_department_ids($1::uuid[])';

// ─── Утилиты ──────────────────────────────────────────────────────────────────

const arg = (name: string): string | null => {
  const found = process.argv.find(item => item.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
};

const diff = (a: string[], b: string[]): string[] => {
  const setB = new Set(b);
  return a.filter(item => !setB.has(item)).sort();
};

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

/** Как expandTimekeeperAccessibleDepartmentIds, но внутри переданной транзакции. */
async function expandSeeds(client: PoolClient, seeds: string[]): Promise<string[]> {
  if (seeds.length === 0) return [];
  const { rows } = await client.query<{ id: string }>(SUBTREE_SQL, [seeds]);
  return [...new Set([...seeds, ...rows.map(r => r.id), LI_OBSHESTROY_DEPARTMENT_ID])];
}

interface IUserResult {
  userId: string;
  fullName: string | null;
  oldSeeds: string[];
  newSeeds: string[];
  oldDirect: string[];
  newDirect: string[];
  oldManaged: string[];
  newManaged: string[];
  oldHasDirect: boolean;
  newHasDirect: boolean;
  oldMs: number;
  newMs: number;
}

async function compareForUser(
  client: PoolClient,
  userId: string,
  fullName: string | null,
): Promise<IUserResult> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query(`SET LOCAL statement_timeout = ${VERIFY_STATEMENT_TIMEOUT_MS}`);

    // --- СТАРЫЙ путь -------------------------------------------------------
    const oldStarted = Date.now();
    const folders = await client.query<{ department_id: string }>(OLD_FOLDERS_SQL, [userId]);
    const folderIds = [...new Set(folders.rows.map(r => r.department_id))];
    let oldSeeds: string[] = [];
    if (folderIds.length > 0) {
      const seedRows = await client.query<{ id: string }>(
        OLD_SEEDS_SQL,
        [userId, folderIds, LI_OBSHESTROY_DEPARTMENT_ID],
      );
      oldSeeds = [...new Set(seedRows.rows.map(r => r.id))];
    }
    const directRows = await client.query<{ employee_id: number | string | null }>(OLD_DIRECT_SQL, [userId]);
    const oldDirect = [...new Set(
      directRows.rows
        .map(r => Number(r.employee_id))
        .filter((id): id is number => Number.isInteger(id)),
    )];
    const oldMs = Date.now() - oldStarted;

    // --- НОВЫЙ путь --------------------------------------------------------
    const newStarted = Date.now();
    const snapshot = await client.query<ITimekeeperScopeRow>(
      TIMEKEEPER_SCOPE_SNAPSHOT_SQL,
      [userId, LI_OBSHESTROY_DEPARTMENT_ID],
    );
    const parsed = parseTimekeeperScopeRows(snapshot.rows);
    const newSeeds = parsed.departmentSeeds;
    const newDirect = parsed.directEmployeeIds;
    const newMs = Date.now() - newStarted;

    // --- Профильные поля: managed_department_ids и has_direct_reports ------
    const oldManaged = await expandSeeds(client, oldSeeds);
    const newManaged = await expandSeeds(client, newSeeds);

    return {
      userId,
      fullName,
      oldSeeds: sortedUnique(oldSeeds),
      newSeeds: sortedUnique(newSeeds),
      oldDirect: sortedUnique(oldDirect.map(String)),
      newDirect: sortedUnique(newDirect.map(String)),
      oldManaged: sortedUnique(oldManaged),
      newManaged: sortedUnique(newManaged),
      oldHasDirect: oldDirect.length > 0,
      newHasDirect: newDirect.length > 0,
      oldMs,
      newMs,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

function reportUser(result: IUserResult): boolean {
  const checks: Array<[string, string[], string[]]> = [
    ['seeds', result.oldSeeds, result.newSeeds],
    ['direct', result.oldDirect, result.newDirect],
    ['managed_department_ids', result.oldManaged, result.newManaged],
  ];

  const label = `${result.userId}${result.fullName ? ` (${result.fullName})` : ''}`;
  let ok = true;

  for (const [name, oldValues, newValues] of checks) {
    const lost = diff(oldValues, newValues);
    const gained = diff(newValues, oldValues);
    if (lost.length === 0 && gained.length === 0) continue;
    ok = false;
    console.error(`  [РАСХОЖДЕНИЕ] ${name}: было ${oldValues.length}, стало ${newValues.length}`);
    if (lost.length > 0) console.error(`    пропало (old EXCEPT new): ${lost.join(', ')}`);
    if (gained.length > 0) console.error(`    появилось (new EXCEPT old): ${gained.join(', ')}`);
  }

  if (result.oldHasDirect !== result.newHasDirect) {
    ok = false;
    console.error(`  [РАСХОЖДЕНИЕ] has_direct_reports: было ${result.oldHasDirect}, стало ${result.newHasDirect}`);
  }

  const speedup = result.newMs > 0 ? (result.oldMs / result.newMs).toFixed(1) : '∞';
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${label} | seeds=${result.newSeeds.length} direct=${result.newDirect.length}` +
    ` managed=${result.newManaged.length} | старый ${result.oldMs} мс → новый ${result.newMs} мс (×${speedup})`,
  );
  return ok;
}

async function main(): Promise<number> {
  if (!process.argv.includes('--yes')) {
    console.error('Старый запрос идёт по 12–15 с и способен положить прод.');
    console.error('Запускать только в непиковое время или на реплике. Подтвердите флагом --yes.');
    return 2;
  }

  const onlyUser = arg('user');
  const limitRaw = arg('limit');
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  const expectRaw = arg('expect');
  const expected = expectRaw ? Number.parseInt(expectRaw, 10) : DEFAULT_EXPECTED_TIMEKEEPERS;
  if (!Number.isInteger(expected) || expected <= 0) {
    console.error(`Некорректный --expect=${expectRaw}: нужно целое положительное число.`);
    return 2;
  }

  const pool = getPool();
  const client = await pool.connect();
  let failures = 0;
  let total = 0;

  try {
    // Табельщицы по роли + все, у кого есть назначения (защита от пропуска).
    const { rows: users } = await client.query<{ id: string; full_name: string | null }>(
      `SELECT up.id, up.full_name
         FROM user_profiles up
         JOIN system_roles sr ON sr.id = up.system_role_id
        WHERE sr.code = 'timekeeper'
       UNION
       SELECT up.id, up.full_name
         FROM user_profiles up
        WHERE up.id IN (SELECT timekeeper_user_id FROM timekeeper_object_access WHERE is_active = true)
           OR up.id IN (SELECT timekeeper_user_id FROM timekeeper_folder_access WHERE is_active = true)
        ORDER BY 1`,
    );

    console.log(`Найдено табельщиц в БД: ${users.length}`);

    // Пустая выборка НЕ должна выглядеть успехом: иначе опечатка в --user или
    // сломанный запрос выборки дадут «ВОРОТА A ПРОЙДЕНЫ» с кодом 0 на нуле сверок.
    if (users.length === 0) {
      console.error('ВОРОТА A НЕ ПРОЙДЕНЫ: в БД не найдено ни одной табельщицы. Проверьте подключение и роль timekeeper.');
      return 1;
    }

    if (onlyUser && !users.some(u => u.id === onlyUser)) {
      console.error(`ВОРОТА A НЕ ПРОЙДЕНЫ: пользователь --user=${onlyUser} не найден среди табельщиц.`);
      return 1;
    }

    // Полный прогон обязан покрыть ожидаемое число табельщиц. Расхождение = выборка
    // сломалась (роль переименована, доступ урезан) — это не повод считать ворота взятыми.
    const isFullRun = !onlyUser && !limit;
    if (isFullRun && users.length !== expected) {
      console.error(
        `ВОРОТА A НЕ ПРОЙДЕНЫ: ожидалось ${expected} табельщиц, найдено ${users.length}.` +
        ' Если состав изменился законно — перезапустите с --expect=<N>.',
      );
      return 1;
    }

    const targets = users
      .filter(u => !onlyUser || u.id === onlyUser)
      .slice(0, limit && limit > 0 ? limit : undefined);

    if (targets.length === 0) {
      console.error('ВОРОТА A НЕ ПРОЙДЕНЫ: после фильтров не осталось ни одного пользователя для сверки.');
      return 1;
    }

    if (!isFullRun) {
      console.warn(
        `ВНИМАНИЕ: частичный прогон (${targets.length} из ${users.length}). Для снятия блокировки деплоя` +
        ' нужен полный прогон без --user и --limit.',
      );
    }

    console.log(`К сверке: ${targets.length} (последовательно, по одной транзакции на каждого)\n`);

    for (const user of targets) {
      total += 1;
      const result = await compareForUser(client, user.id, user.full_name);
      if (!reportUser(result)) failures += 1;
    }

    console.log('');
    console.log(`Найдено ${users.length}, сверено ${total}, расхождений ${failures}.`);

    if (total === 0) {
      console.error('ВОРОТА A НЕ ПРОЙДЕНЫ: ни одной сверки не выполнено.');
      return 1;
    }
    if (failures > 0) {
      console.error(`ВОРОТА A НЕ ПРОЙДЕНЫ: расхождения у ${failures} из ${total}. Деплой запрещён.`);
      return 1;
    }
    if (!isFullRun) {
      console.error('ВОРОТА A НЕ ПРОЙДЕНЫ: частичный прогон не снимает блокировку деплоя.');
      return 1;
    }
    console.log(`ВОРОТА A ПРОЙДЕНЫ: расхождений нет по всем ${total} табельщицам.`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error('[verify-timekeeper-scope] упал:', error);
    process.exit(1);
  });
