/**
 * Слияние дублей, порождённых сменой карточки Sigur (инцидент 14.08.2026).
 *
 * Тик синка 14.08 увидел старую карточку человека в архивной папке Sigur и новую —
 * в рабочем отделе, и оформил это как «увольнение + приём нового сотрудника».
 * В табеле человек стоит двумя строками: старый профиль с историей и табельным
 * номером (уволен) и новый пустой (активен).
 *
 * Скрипт возвращает состояние «один профиль на человека»: старый FOT id остаётся,
 * к нему переезжает новая карточка Sigur, проходы объединяются, сводка
 * пересчитывается, ошибочное событие увольнения помечается cancelled, дубль удаляется.
 *
 * Режимы:
 *   npx tsx scripts/merge-sigur-rebound-duplicates.ts             — dry-run (по умолчанию)
 *   npx tsx scripts/merge-sigur-rebound-duplicates.ts --apply     — применяет
 *
 * Порядок обязателен: сначала бэкенд с rebind-гардом (иначе ближайший тик синка
 * пересоздаст дубли), бэкенд на время запуска остановлен (presence-polling кэширует
 * sigurId → employee_id на 10 минут и привязал бы свежие проходы к удалённому профилю).
 *
 * Гарантии:
 *  - две фазы: сначала валидируются ВСЕ пары, запись начинается только если валидны все;
 *  - пары описаны полным ожидаемым состоянием (ФИО, оба Sigur ID, дата увольнения,
 *    отдел, табельный номер) — любое расхождение останавливает скрипт с кодом 1;
 *  - ссылки на удаляемый профиль инвентаризируются динамически по pg_constraint;
 *  - правка одной пары — одна транзакция, включая техдоступ и аудит;
 *  - состояние обоих профилей до правки сохраняется в merge_sigur_rebound_backup.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_LOCK_KEY = 823_140_814; // произвольный, уникальный для этого скрипта

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

// Локальный запуск: DATABASE_URL и CA из fot-server/.env (как в fix-sync-reverted-dismissals.ts).
const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL не найден в fot-server/.env');
    process.exit(1);
  }
  try {
    const u = new URL(rawUrl);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

interface IPair {
  /** Профиль, который остаётся (вся история, документы, табельный номер). */
  oldId: number;
  /** Дубль, созданный синком под новой карточкой Sigur. Будет удалён. */
  newId: number;
  fullName: string;
  oldSigurId: number;
  newSigurId: number;
  /** Дата ошибочного увольнения старого профиля. */
  dismissalDate: string;
  /** Отдел новой карточки — куда возвращается старый профиль. */
  departmentId: string;
  /** Табельный номер, который обязан сохраниться (null — его и не было). */
  keepTabNumber: string | null;
}

const PAIRS: IPair[] = [
  {
    oldId: 2568,
    newId: 13403,
    fullName: 'Шарипов Исмоилджон Нуруллоевич',
    oldSigurId: 143276,
    newSigurId: 125698,
    dismissalDate: '2026-08-14',
    departmentId: 'c9c64ff6-d166-4109-b23f-4bdb1bc45bd0', // бр.Прозорова А.В.
    keepTabNumber: '05919',
  },
  {
    oldId: 2550,
    newId: 13404,
    fullName: 'Мустафаев Уктам Мустафаевич',
    oldSigurId: 143271,
    newSigurId: 142215,
    dismissalDate: '2026-08-14',
    departmentId: '76ea6b67-fdfe-46e8-aee5-9ade962c16fe', // бр.Амонова М.Н.
    keepTabNumber: '05967',
  },
];

/** Таблицы, ссылки которых на удаляемый профиль скрипт умеет обработать. */
const HANDLED_REFERENCES = new Set([
  'skud_events',
  'skud_daily_summary',
  'employee_department_access',
]);

/** `regclass` отдаёт имя со схемой только вне search_path — сравниваем по имени таблицы. */
const bareTableName = (qualified: string): string => qualified.split('.').pop()!.replace(/"/g, '');

const BACKUP_DDL = `
CREATE TABLE IF NOT EXISTS public.merge_sigur_rebound_backup (
  backup_at timestamptz NOT NULL DEFAULT now(),
  pair_old_id bigint NOT NULL,
  pair_new_id bigint NOT NULL,
  employee_id bigint NOT NULL,
  role text NOT NULL,
  snapshot jsonb NOT NULL
);`;

const RESTORE_HINT = `
-- Откат (по паре, подставить :old/:new):
-- Старый профиль: UPDATE employees SET ... FROM (SELECT snapshot FROM public.merge_sigur_rebound_backup
--   WHERE pair_old_id = :old AND role = 'old' ORDER BY backup_at DESC LIMIT 1) b ...
-- Удалённый дубль: INSERT в employees из snapshot (role = 'new'), затем вернуть ему
--   skud_events/skud_daily_summary по датам из отчёта. Проходы переносились UPDATE-ом,
--   поэтому обратный перенос — по event_date >= даты увольнения и physical_person.`;

interface IEmployeeRow {
  id: number;
  full_name: string | null;
  employment_status: string;
  dismissal_date: string | null;
  dismissal_apply_started_at: string | null;
  sigur_employee_id: number | null;
  org_department_id: string | null;
  position_id: string | null;
  tab_number: string | null;
  is_archived: boolean;
}

interface IValidatedPair {
  pair: IPair;
  /** Уже слито в предыдущем запуске — фаза 2 такую пару пропускает. */
  alreadyMerged: boolean;
  dismissalEventId?: string;
  positionId?: string | null;
  oldEvents?: number;
  newEvents?: number;
  recalcDates?: string[];
}

const normalizeName = (value: string): string =>
  value.replace(/ё/gi, 'е').replace(/\s+/g, ' ').trim().toLowerCase();

async function loadEmployee(client: PoolClient, id: number): Promise<IEmployeeRow | null> {
  const res = await client.query<IEmployeeRow>(
    `SELECT id, full_name, employment_status,
            dismissal_date::text AS dismissal_date,
            dismissal_apply_started_at::text AS dismissal_apply_started_at,
            sigur_employee_id, org_department_id, position_id, tab_number, is_archived
       FROM employees WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Ссылки на сотрудника по всем FK на public.employees (без партиций — они дублируют родителя). */
async function countReferences(
  client: PoolClient,
  employeeId: number,
): Promise<Array<{ table: string; column: string; count: number }>> {
  const fks = await client.query<{ tbl: string; col: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND c.confrelid = 'public.employees'::regclass
        AND rel.relispartition = false
      ORDER BY 1, 2`,
  );

  const out: Array<{ table: string; column: string; count: number }> = [];
  for (const fk of fks.rows) {
    const res = await client.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM ${fk.tbl} WHERE ${fk.col} = $1`,
      [employeeId],
    );
    const count = Number(res.rows[0]?.cnt ?? 0);
    if (count > 0) out.push({ table: fk.tbl, column: fk.col, count });
  }
  return out;
}

/** Фаза 1: проверяет пару целиком. Бросает ошибку при любом расхождении. */
async function validatePair(client: PoolClient, pair: IPair): Promise<IValidatedPair> {
  const label = `${pair.fullName} (${pair.oldId} ← ${pair.newId})`;
  const oldEmp = await loadEmployee(client, pair.oldId);
  const newEmp = await loadEmployee(client, pair.newId);

  if (!oldEmp) throw new Error(`${label}: старый профиль ${pair.oldId} не найден`);
  if (normalizeName(oldEmp.full_name ?? '') !== normalizeName(pair.fullName)) {
    throw new Error(`${label}: ФИО старого профиля не совпадает («${oldEmp.full_name}»)`);
  }

  // Уже слито в предыдущем запуске — допускаем только полное целевое состояние.
  if (!newEmp) {
    const ok = oldEmp.employment_status === 'active'
      && Number(oldEmp.sigur_employee_id) === pair.newSigurId
      && oldEmp.org_department_id === pair.departmentId
      && (oldEmp.tab_number ?? null) === pair.keepTabNumber;
    if (!ok) {
      throw new Error(
        `${label}: дубль ${pair.newId} отсутствует, но старый профиль не в целевом состоянии `
        + `(status=${oldEmp.employment_status}, sigur=${oldEmp.sigur_employee_id}, `
        + `dept=${oldEmp.org_department_id}, tab=${oldEmp.tab_number})`,
      );
    }
    return { pair, alreadyMerged: true };
  }

  if (Number(oldEmp.sigur_employee_id) !== pair.oldSigurId) {
    throw new Error(`${label}: sigur_employee_id старого = ${oldEmp.sigur_employee_id}, ожидался ${pair.oldSigurId}`);
  }
  if (oldEmp.employment_status !== 'fired') {
    throw new Error(`${label}: старый профиль не fired (${oldEmp.employment_status})`);
  }
  if (oldEmp.dismissal_date !== pair.dismissalDate) {
    throw new Error(`${label}: dismissal_date старого = ${oldEmp.dismissal_date}, ожидалась ${pair.dismissalDate}`);
  }
  if ((oldEmp.tab_number ?? null) !== pair.keepTabNumber) {
    throw new Error(`${label}: tab_number старого = ${oldEmp.tab_number}, ожидался ${pair.keepTabNumber}`);
  }
  if (normalizeName(newEmp.full_name ?? '') !== normalizeName(pair.fullName)) {
    throw new Error(`${label}: ФИО дубля не совпадает («${newEmp.full_name}»)`);
  }
  if (Number(newEmp.sigur_employee_id) !== pair.newSigurId) {
    throw new Error(`${label}: sigur_employee_id дубля = ${newEmp.sigur_employee_id}, ожидался ${pair.newSigurId}`);
  }
  if (newEmp.employment_status !== 'active') {
    throw new Error(`${label}: дубль не active (${newEmp.employment_status})`);
  }
  if (newEmp.org_department_id !== pair.departmentId) {
    throw new Error(`${label}: отдел дубля = ${newEmp.org_department_id}, ожидался ${pair.departmentId}`);
  }
  if (newEmp.dismissal_apply_started_at != null) {
    throw new Error(`${label}: у дубля висит claim увольнения (${newEmp.dismissal_apply_started_at})`);
  }

  // История отделов: ретро-правку периодов скрипт не делает — членство идёт по snapshot.
  const assignments = await client.query<{ employee_id: number; org_department_id: string | null; effective_from: string; effective_to: string | null }>(
    `SELECT employee_id, org_department_id, effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM employee_assignments WHERE employee_id = ANY($1::int[]) ORDER BY employee_id, effective_from`,
    [[pair.oldId, pair.newId]],
  );
  if (assignments.rows.length > 0) {
    console.error(`${label}: найдены employee_assignments — требуется ручное решение:`);
    for (const a of assignments.rows) {
      console.error(`    emp=${a.employee_id} dept=${a.org_department_id} ${a.effective_from} → ${a.effective_to ?? '∞'}`);
    }
    throw new Error(`${label}: история назначений не пуста, автоматическая правка невозможна`);
  }

  const events = await client.query<{ id: string }>(
    `SELECT id FROM employee_dismissal_events
      WHERE employee_id = $1 AND dismissal_date = $2::date AND cancelled = false`,
    [pair.oldId, pair.dismissalDate],
  );
  if (events.rows.length !== 1) {
    throw new Error(`${label}: ожидалось ровно одно неотменённое событие увольнения от ${pair.dismissalDate}, найдено ${events.rows.length}`);
  }

  const refs = await countReferences(client, pair.newId);
  const unexpected = refs.filter(r => !HANDLED_REFERENCES.has(bareTableName(r.table)));
  if (unexpected.length > 0) {
    console.error(`${label}: неожиданные ссылки на дубль:`);
    for (const r of unexpected) console.error(`    ${r.table}.${r.column}: ${r.count}`);
    throw new Error(`${label}: есть ссылки на дубль вне обрабатываемого списка`);
  }
  console.log(`  ссылки на дубль: ${refs.map(r => `${r.table}=${r.count}`).join(', ') || 'нет'}`);

  const counts = await client.query<{ employee_id: number; cnt: string }>(
    `SELECT employee_id, count(*)::text AS cnt FROM skud_events
      WHERE employee_id = ANY($1::int[]) GROUP BY employee_id`,
    [[pair.oldId, pair.newId]],
  );
  const oldEvents = Number(counts.rows.find(r => Number(r.employee_id) === pair.oldId)?.cnt ?? 0);
  const newEvents = Number(counts.rows.find(r => Number(r.employee_id) === pair.newId)?.cnt ?? 0);

  // Пересчитываем только затронутые даты; функция сама добавит date - 1 (ночные смены).
  const dates = await client.query<{ d: string }>(
    `SELECT DISTINCT event_date::text AS d FROM skud_events
      WHERE employee_id = ANY($1::int[]) AND event_date >= $2::date ORDER BY 1`,
    [[pair.oldId, pair.newId], pair.dismissalDate],
  );

  return {
    pair,
    alreadyMerged: false,
    dismissalEventId: events.rows[0].id,
    positionId: newEmp.position_id ?? oldEmp.position_id ?? null,
    oldEvents,
    newEvents,
    recalcDates: dates.rows.map(r => r.d),
  };
}

/** Фаза 2: применяет одну пару в собственной транзакции. */
async function applyPair(client: PoolClient, v: IValidatedPair): Promise<void> {
  const { pair } = v;
  const now = new Date().toISOString();

  await client.query('BEGIN');
  try {
    // Backup обоих профилей до правки.
    await client.query(
      `INSERT INTO public.merge_sigur_rebound_backup (pair_old_id, pair_new_id, employee_id, role, snapshot)
       SELECT $1, $2, e.id, CASE WHEN e.id = $1 THEN 'old' ELSE 'new' END, to_jsonb(e)
         FROM employees e WHERE e.id = ANY($3::int[])`,
      [pair.oldId, pair.newId, [pair.oldId, pair.newId]],
    );

    // Sigur ID уникален (partial unique index) — сначала снимаем его с дубля.
    await client.query('UPDATE employees SET sigur_employee_id = NULL, updated_at = $1 WHERE id = $2', [now, pair.newId]);

    await client.query(
      `UPDATE employees
          SET sigur_employee_id = $1,
              org_department_id = $2,
              position_id = COALESCE($3, position_id),
              employment_status = 'active',
              dismissal_date = NULL,
              dismissal_apply_started_at = NULL,
              excluded_from_timesheet = false,
              excluded_from_timesheet_date = NULL,
              updated_at = $4
        WHERE id = $5`,
      [pair.newSigurId, pair.departmentId, v.positionId ?? null, now, pair.oldId],
    );

    // Ошибочное увольнение помечаем отменённым в самой строке — второе событие
    // не вставляем, иначе в истории окажутся две отмены.
    await client.query(
      `UPDATE employee_dismissal_events
          SET cancelled = true,
              reason = COALESCE(reason, 'Смена карточки Sigur — увольнение ошибочно')
        WHERE id = $1`,
      [v.dismissalEventId],
    );

    await client.query('UPDATE skud_events SET employee_id = $1 WHERE employee_id = $2', [pair.oldId, pair.newId]);

    // Сводка: строки обоих профилей за затронутый период удаляем и пересчитываем заново
    // (у обоих есть строка на дату увольнения — прямой перенос упёрся бы в уникальность).
    await client.query(
      'DELETE FROM skud_daily_summary WHERE employee_id = ANY($1::int[]) AND date >= $2::date',
      [[pair.oldId, pair.newId], pair.dismissalDate],
    );
    const recalcPairs = (v.recalcDates ?? []).map(d => ({ emp_id: pair.oldId, date: d }));
    if (recalcPairs.length > 0) {
      await client.query('SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)', [JSON.stringify(recalcPairs)]);
    }

    // Технический доступ — тем же соединением: падение после коммита оставило бы
    // активного сотрудника невидимым руководителю.
    await client.query(
      `INSERT INTO employee_department_access
         (employee_id, department_id, source, is_active, created_at, updated_at)
       VALUES ($1, $2, 'sigur_sync', true, $3, $3)
       ON CONFLICT (employee_id, department_id)
       DO UPDATE SET is_active = true, updated_at = EXCLUDED.updated_at`,
      [pair.oldId, pair.departmentId, now],
    );

    // Дубль удаляем: его employee_department_access уходит каскадом. Оставлять его
    // активным «портальным» нельзя — синк привяжет к нему первую же карточку по ФИО.
    await client.query('DELETE FROM employees WHERE id = $1', [pair.newId]);

    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'MERGE_SIGUR_REBOUND_DUPLICATE', 'employee', $1, $2::jsonb)`,
      [String(pair.oldId), JSON.stringify({
        employee_id: pair.oldId,
        deleted_employee_id: pair.newId,
        name: pair.fullName,
        old_sigur_id: pair.oldSigurId,
        new_sigur_id: pair.newSigurId,
        department_id: pair.departmentId,
        cancelled_dismissal_event_id: v.dismissalEventId,
        moved_events: v.newEvents ?? 0,
        recalculated_dates: v.recalcDates ?? [],
      })],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Постусловия: одна активная строка на человека, дубля нет, проходы сложились. */
async function verifyPair(client: PoolClient, v: IValidatedPair): Promise<void> {
  const { pair } = v;
  const emp = await loadEmployee(client, pair.oldId);
  const problems: string[] = [];
  if (!emp) problems.push('старый профиль исчез');
  else {
    if (emp.employment_status !== 'active') problems.push(`status=${emp.employment_status}`);
    if (Number(emp.sigur_employee_id) !== pair.newSigurId) problems.push(`sigur=${emp.sigur_employee_id}`);
    if (emp.org_department_id !== pair.departmentId) problems.push(`dept=${emp.org_department_id}`);
    if ((emp.tab_number ?? null) !== pair.keepTabNumber) problems.push(`tab=${emp.tab_number}`);
    if (emp.dismissal_date != null) problems.push(`dismissal_date=${emp.dismissal_date}`);
  }

  const dup = await loadEmployee(client, pair.newId);
  if (dup) problems.push(`дубль ${pair.newId} всё ещё существует`);
  else {
    const refs = await countReferences(client, pair.newId);
    if (refs.length > 0) problems.push(`остались ссылки на дубль: ${refs.map(r => `${r.table}=${r.count}`).join(', ')}`);
  }

  const cnt = await client.query<{ cnt: string }>(
    'SELECT count(*)::text AS cnt FROM skud_events WHERE employee_id = $1', [pair.oldId],
  );
  const expected = (v.oldEvents ?? 0) + (v.newEvents ?? 0);
  if (Number(cnt.rows[0]?.cnt ?? -1) !== expected) {
    problems.push(`проходов ${cnt.rows[0]?.cnt}, ожидалось ${expected}`);
  }

  const dupSummary = await client.query<{ cnt: string }>(
    'SELECT count(*)::text AS cnt FROM skud_daily_summary WHERE employee_id = $1', [pair.newId],
  );
  if (Number(dupSummary.rows[0]?.cnt ?? 0) > 0) problems.push('в сводке остались строки дубля');

  if (problems.length > 0) {
    throw new Error(`Постусловия не выполнены для ${pair.fullName} (${pair.oldId}): ${problems.join(', ')}`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const mode = apply ? 'apply' : 'dry-run';

  const { getPool } = await import('../src/config/postgres.js');
  const client = await getPool().connect();

  let exitCode = 0;
  try {
    const who = await client.query<{ current_user: string; db: string }>(
      'SELECT current_user, current_database() AS db',
    );
    console.log(`Подключение: user=${who.rows[0].current_user}, db=${who.rows[0].db}`);
    console.log(`Режим: ${mode}\n`);

    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [SCRIPT_LOCK_KEY],
    );
    if (!lock.rows[0].locked) throw new Error('Скрипт уже выполняется другим процессом');

    // ─── Фаза 1: валидация всех пар, без записи ───
    const validated: IValidatedPair[] = [];
    console.log('=== ФАЗА 1: ВАЛИДАЦИЯ ===');
    for (const pair of PAIRS) {
      console.log(`\n${pair.fullName}: ${pair.oldId} (sigur ${pair.oldSigurId}) ← ${pair.newId} (sigur ${pair.newSigurId})`);
      const v = await validatePair(client, pair);
      if (v.alreadyMerged) {
        console.log('  уже слито ранее — пропуск');
      } else {
        console.log(`  проходов: старый ${v.oldEvents}, дубль ${v.newEvents} → станет ${(v.oldEvents ?? 0) + (v.newEvents ?? 0)}`);
        console.log(`  пересчёт сводки за: ${(v.recalcDates ?? []).join(', ') || 'нет дат'}`);
        console.log(`  отменяемое событие увольнения: ${v.dismissalEventId}`);
      }
      validated.push(v);
    }

    const toApply = validated.filter(v => !v.alreadyMerged);
    console.log(`\nВалидация пройдена. К применению пар: ${toApply.length}`);

    if (!apply) {
      console.log('\nDry-run: изменения не вносились. Запустить с --apply для применения.');
      await client.query('SELECT pg_advisory_unlock($1)', [SCRIPT_LOCK_KEY]);
      return;
    }

    // ─── Фаза 2: применение ───
    console.log('\n=== ФАЗА 2: ПРИМЕНЕНИЕ ===');
    await client.query(BACKUP_DDL);
    for (const v of toApply) {
      await applyPair(client, v);
      await verifyPair(client, v);
      console.log(`  ${v.pair.fullName}: id=${v.pair.oldId} ← sigur ${v.pair.newSigurId}, `
        + `перенесено проходов ${v.newEvents}, пересчитано дней ${(v.recalcDates ?? []).length}, дубль ${v.pair.newId} удалён`);
    }

    console.log(RESTORE_HINT);
    console.log('\nГотово. Запустить бэкенд и проверить табель бригад.');
    await client.query('SELECT pg_advisory_unlock($1)', [SCRIPT_LOCK_KEY]);
  } catch (err) {
    console.error(`\nОСТАНОВ: ${err instanceof Error ? err.message : String(err)}`);
    exitCode = 1;
  } finally {
    client.release();
  }

  process.exit(exitCode);
}

// Прямой запуск (не импорт из тестов).
if (process.argv[1] && process.argv[1].includes('merge-sigur-rebound-duplicates')) {
  main().catch(err => {
    console.error('Ошибка:', err?.stack ?? err?.message ?? err);
    process.exit(1);
  });
}
