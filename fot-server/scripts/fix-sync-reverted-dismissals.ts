/**
 * Разбор увольнений, откаченных синком Sigur (инцидент 10–13.08.2026).
 *
 * Вход — файл кадровой сверки (JSON), построенный по отчёту
 * `scripts/report-sync-reverted-dismissals.sql`. Формат:
 *
 *   {
 *     "decisions": [
 *       { "employeeId": 128, "outcome": "confirmed_fired", "dismissalDate": "2026-08-12" },
 *       { "employeeId": 921, "outcome": "legitimate_rehire" },
 *       { "employeeId": 555, "outcome": "unconfirmed" }
 *     ]
 *   }
 *
 * Режимы:
 *   npx tsx scripts/fix-sync-reverted-dismissals.ts --file=review.json --check   — только чтение, печатает план
 *   npx tsx scripts/fix-sync-reverted-dismissals.ts --file=review.json --yes     — применяет
 *
 * Порядок обязателен: сначала деплой бэкенда с фиксом синка (реактивация убрана,
 * skip-fired, гард auto-fire), затем --check, затем --yes. До деплоя ближайший синк
 * снова снимет fired.
 *
 * Гарантии:
 *  - строки сотрудника блокируются FOR UPDATE, состояние перепроверяется в момент применения;
 *  - backup employees / employee_assignments / employee_department_access — в постоянные
 *    таблицы fix_sync_reverted_backup_* (restore-SQL печатается в конце);
 *  - назначения правятся по строгому алгоритму (см. planAssignments), спорные случаи
 *    не трогаются вовсе — сотрудник уходит в отчёт на ручную сверку;
 *  - аудит пишется в той же транзакции, ошибка аудита откатывает изменение;
 *  - вызовы Sigur выполняются ПОСЛЕ коммита, вне транзакции, и не удерживают блокировок.
 *
 * Общего advisory-lock с синком структуры в коде нет; после фикса части 1 он и не нужен —
 * синк не меняет уволенных. Скрипт берёт собственный сессионный lock, чтобы два его
 * экземпляра не пересеклись.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SCRIPT_LOCK_KEY = 823_140_112; // произвольный, уникальный для этого скрипта

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

// Локальный запуск: DATABASE_URL и CA из fot-server/.env (как в apply-migration-236.ts).
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

type TOutcome = 'confirmed_fired' | 'legitimate_rehire' | 'unconfirmed';

interface IDecision {
  employeeId: number;
  outcome: TOutcome;
  /** Дата увольнения по кадрам. Если не указана — берётся из последнего события. */
  dismissalDate?: string;
  note?: string;
}

interface IAssignmentRow {
  id: string;
  org_department_id: string | null;
  position_id: string | null;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  created_at: string;
}

type TAssignmentAction =
  | { kind: 'close'; id: string; effectiveTo: string }
  | { kind: 'delete'; id: string; reason: string }
  | { kind: 'keep'; id: string };

/** Причины назначений, которые оставляет только синк Sigur. */
const SYNC_REASONS = new Set([
  'Синхронизация Sigur',
  'Восстановление (синхронизация Sigur)',
  'Увольнение — перевод в папку "Уволенные"',
]);

const shiftDate = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * Что делать с открытыми назначениями вне архива.
 *
 * Простое «закрыть датой D» неверно: на проде большинство таких назначений
 * СОЗДАНЫ синком уже после отката и начинаются позже D — `effective_to = D` дал бы
 * конец раньше начала. Правила:
 *  - effective_from <= D → закрыть по D;
 *  - effective_from > D и доказанный sync-артефакт (причина из SYNC_REASONS И запись
 *    создана не раньше события увольнения) → удалить (с backup);
 *  - иначе → null: сотрудник целиком уходит на ручную сверку, ничего не меняем.
 */
export function planAssignments(
  openOutsideArchive: IAssignmentRow[],
  dismissalDate: string,
  dismissalEventAt: string,
): TAssignmentAction[] | null {
  const actions: TAssignmentAction[] = [];
  for (const row of openOutsideArchive) {
    if (row.effective_from <= dismissalDate) {
      actions.push({ kind: 'close', id: row.id, effectiveTo: dismissalDate });
      continue;
    }
    const isSyncReason = row.change_reason != null && SYNC_REASONS.has(row.change_reason);
    const createdAfterDismissal = row.created_at >= dismissalEventAt;
    if (isSyncReason && createdAfterDismissal) {
      actions.push({ kind: 'delete', id: row.id, reason: row.change_reason! });
      continue;
    }
    return null; // ручная причина или неоднозначность — не трогаем сотрудника
  }
  return actions;
}

interface IEmployeeState {
  id: number;
  full_name: string | null;
  employment_status: string;
  dismissal_date: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | null;
  dismissal_apply_started_at: string | null;
}

const BACKUP_DDL = `
CREATE TABLE IF NOT EXISTS public.fix_sync_reverted_backup_employees (
  backup_at timestamptz NOT NULL DEFAULT now(),
  employee_id bigint NOT NULL,
  employment_status text,
  dismissal_date date,
  excluded_from_timesheet boolean,
  excluded_from_timesheet_date date,
  org_department_id uuid,
  dismissal_apply_started_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.fix_sync_reverted_backup_assignments (
  backup_at timestamptz NOT NULL DEFAULT now(),
  employee_id bigint NOT NULL,
  assignment_id uuid NOT NULL,
  org_department_id uuid,
  position_id uuid,
  effective_from date,
  effective_to date,
  is_primary boolean,
  assignment_type text,
  change_reason text,
  created_at timestamptz,
  action text NOT NULL
);
CREATE TABLE IF NOT EXISTS public.fix_sync_reverted_backup_access (
  backup_at timestamptz NOT NULL DEFAULT now(),
  employee_id bigint NOT NULL,
  access_id uuid NOT NULL,
  org_department_id uuid,
  is_active boolean
);`;

const RESTORE_HINT = `
-- Откат (по одному сотруднику, подставить :emp):
-- UPDATE employees e SET employment_status=b.employment_status, dismissal_date=b.dismissal_date,
--        excluded_from_timesheet=b.excluded_from_timesheet,
--        excluded_from_timesheet_date=b.excluded_from_timesheet_date,
--        org_department_id=b.org_department_id, dismissal_apply_started_at=b.dismissal_apply_started_at
--   FROM public.fix_sync_reverted_backup_employees b
--  WHERE b.employee_id = e.id AND e.id = :emp;
-- Назначения: строки с action='delete' восстанавливаются INSERT-ом из backup_assignments,
-- строки с action='close' — возвратом effective_to из backup.`;

async function loadDecisions(filePath: string): Promise<IDecision[]> {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { decisions?: IDecision[] };
  if (!Array.isArray(raw.decisions) || raw.decisions.length === 0) {
    throw new Error('В файле сверки нет массива decisions');
  }
  for (const d of raw.decisions) {
    if (!Number.isInteger(d.employeeId)) throw new Error(`Некорректный employeeId: ${JSON.stringify(d)}`);
    if (!['confirmed_fired', 'legitimate_rehire', 'unconfirmed'].includes(d.outcome)) {
      throw new Error(`Неизвестный outcome у ${d.employeeId}: ${d.outcome}`);
    }
  }
  return raw.decisions;
}

async function resolveArchiveDepartmentId(client: PoolClient): Promise<string> {
  const row = await client.query<{ id: string }>(
    `SELECT value AS id FROM system_settings WHERE key = 'employees_archive_department_id'`,
  );
  if (row.rows[0]?.id) return row.rows[0].id;
  const byName = await client.query<{ id: string }>(
    `SELECT id FROM org_departments WHERE name = 'Уволенные' AND is_active = true ORDER BY parent_id NULLS FIRST LIMIT 1`,
  );
  if (!byName.rows[0]?.id) throw new Error('Не удалось определить локальный архивный отдел');
  return byName.rows[0].id;
}

interface IPlan {
  employeeId: number;
  fullName: string | null;
  outcome: TOutcome;
  dismissalDate?: string;
  assignmentActions?: TAssignmentAction[];
  archiveAssignment?: 'create' | 'reopen' | 'ok';
  accessToDeactivate?: number;
  sigurEmployeeId?: number | null;
  skipReason?: string;
}

/** Строит план по одному сотруднику. Клиент уже в транзакции, строки заблокированы. */
async function buildPlan(
  client: PoolClient,
  decision: IDecision,
  archiveDeptId: string,
): Promise<IPlan> {
  const empRes = await client.query<IEmployeeState>(
    `SELECT id, full_name, employment_status, dismissal_date::text AS dismissal_date,
            org_department_id, sigur_employee_id, dismissal_apply_started_at::text AS dismissal_apply_started_at
       FROM employees WHERE id = $1 FOR UPDATE`,
    [decision.employeeId],
  );
  const emp = empRes.rows[0];
  if (!emp) return { employeeId: decision.employeeId, fullName: null, outcome: decision.outcome, skipReason: 'сотрудник не найден' };

  const base: IPlan = {
    employeeId: emp.id,
    fullName: emp.full_name,
    outcome: decision.outcome,
    sigurEmployeeId: emp.sigur_employee_id,
  };

  if (decision.outcome === 'unconfirmed') return { ...base, skipReason: 'кадры не подтвердили' };

  if (decision.outcome === 'legitimate_rehire') {
    if (emp.employment_status !== 'active') return { ...base, skipReason: `статус изменился на ${emp.employment_status}` };
    return base;
  }

  // confirmed_fired
  if (emp.employment_status !== 'active' || emp.dismissal_date != null) {
    return { ...base, skipReason: `состояние изменилось (status=${emp.employment_status}, dismissal_date=${emp.dismissal_date})` };
  }

  const evRes = await client.query<{ dismissal_date: string; created_at: string }>(
    `SELECT dismissal_date::text AS dismissal_date, created_at::text AS created_at
       FROM employee_dismissal_events
      WHERE employee_id = $1 AND NOT cancelled AND NOT rehired
      ORDER BY created_at DESC LIMIT 1`,
    [decision.employeeId],
  );
  const ev = evRes.rows[0];
  if (!ev) return { ...base, skipReason: 'нет неотменённого события увольнения' };

  const dismissalDate = decision.dismissalDate ?? ev.dismissal_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dismissalDate)) {
    return { ...base, skipReason: `некорректная дата увольнения: ${dismissalDate}` };
  }

  const openRes = await client.query<IAssignmentRow>(
    `SELECT id, org_department_id, position_id, effective_from::text AS effective_from,
            effective_to::text AS effective_to, change_reason, created_at::text AS created_at
       FROM employee_assignments
      WHERE employee_id = $1 AND effective_to IS NULL
      ORDER BY effective_from`,
    [decision.employeeId],
  );
  const openOutside = openRes.rows.filter(r => r.org_department_id !== archiveDeptId);
  const openArchive = openRes.rows.filter(r => r.org_department_id === archiveDeptId);

  const actions = planAssignments(openOutside, dismissalDate, ev.created_at);
  if (actions === null) {
    return { ...base, dismissalDate, skipReason: 'открытое назначение начинается позже даты увольнения и не является sync-артефактом — ручная сверка' };
  }

  // Фактическая работа после даты увольнения важнее любых причин в назначениях:
  // проходы СКУД после D означают, что человек продолжал работать, и «восстановление
  // увольнения» датой D исказило бы табель. Такие случаи — только вручную.
  const badgingRes = await client.query<{ cnt: string; last_date: string | null }>(
    `SELECT count(*)::text AS cnt, max(event_date)::text AS last_date
       FROM skud_events WHERE employee_id = $1 AND event_date > $2::date`,
    [decision.employeeId, dismissalDate],
  );
  const badgingCount = Number(badgingRes.rows[0]?.cnt ?? 0);
  if (badgingCount > 0) {
    return {
      ...base,
      dismissalDate,
      skipReason: `после D есть проходы СКУД (${badgingCount}, последний ${badgingRes.rows[0]?.last_date}) — ручная сверка`,
    };
  }

  const wantFrom = shiftDate(dismissalDate, 1);
  let archiveAssignment: 'create' | 'reopen' | 'ok' = 'create';
  if (openArchive.length === 1 && openArchive[0].effective_from === wantFrom) archiveAssignment = 'ok';
  else if (openArchive.length > 0) archiveAssignment = 'reopen';

  const accessRes = await client.query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM employee_department_access WHERE employee_id = $1 AND is_active`,
    [decision.employeeId],
  );

  return {
    ...base,
    dismissalDate,
    assignmentActions: actions,
    archiveAssignment,
    accessToDeactivate: Number(accessRes.rows[0]?.cnt ?? 0),
  };
}

async function applyPlan(client: PoolClient, plan: IPlan, archiveDeptId: string): Promise<void> {
  const empId = plan.employeeId;

  if (plan.outcome === 'legitimate_rehire') {
    await client.query(
      `INSERT INTO public.fix_sync_reverted_backup_employees
         (employee_id, employment_status, dismissal_date, excluded_from_timesheet,
          excluded_from_timesheet_date, org_department_id, dismissal_apply_started_at)
       SELECT id, employment_status, dismissal_date, excluded_from_timesheet,
              excluded_from_timesheet_date, org_department_id, dismissal_apply_started_at
         FROM employees WHERE id = $1`,
      [empId],
    );
    await client.query(
      `UPDATE employees SET dismissal_apply_started_at = NULL, updated_at = now() WHERE id = $1`,
      [empId],
    );
    await client.query(
      `INSERT INTO employee_dismissal_events
         (employee_id, dismissal_date, scheduled, cancelled, rehired, created_by)
       VALUES ($1, CURRENT_DATE, false, false, true, NULL)`,
      [empId],
    );
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
       VALUES (NULL, 'RECONCILE_EMPLOYEE_REHIRE', 'employee', $1, $2::jsonb)`,
      [String(empId), JSON.stringify({ source: 'fix-sync-reverted-dismissals' })],
    );
    return;
  }

  const dismissalDate = plan.dismissalDate!;
  const exclusionDate = shiftDate(dismissalDate, 1);

  await client.query(
    `INSERT INTO public.fix_sync_reverted_backup_employees
       (employee_id, employment_status, dismissal_date, excluded_from_timesheet,
        excluded_from_timesheet_date, org_department_id, dismissal_apply_started_at)
     SELECT id, employment_status, dismissal_date, excluded_from_timesheet,
            excluded_from_timesheet_date, org_department_id, dismissal_apply_started_at
       FROM employees WHERE id = $1`,
    [empId],
  );

  for (const action of plan.assignmentActions ?? []) {
    if (action.kind === 'keep') continue;
    await client.query(
      `INSERT INTO public.fix_sync_reverted_backup_assignments
         (employee_id, assignment_id, org_department_id, position_id, effective_from, effective_to,
          is_primary, assignment_type, change_reason, created_at, action)
       SELECT employee_id, id, org_department_id, position_id, effective_from, effective_to,
              is_primary, assignment_type, change_reason, created_at, $2
         FROM employee_assignments WHERE id = $1`,
      [action.id, action.kind],
    );
    if (action.kind === 'close') {
      await client.query(
        `UPDATE employee_assignments SET effective_to = $1, updated_at = now() WHERE id = $2`,
        [action.effectiveTo, action.id],
      );
    } else {
      await client.query('DELETE FROM employee_assignments WHERE id = $1', [action.id]);
    }
  }

  // Каноническое архивное назначение с D+1.
  if (plan.archiveAssignment === 'reopen') {
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM employee_assignments
        WHERE employee_id = $1 AND org_department_id = $2 AND effective_to IS NULL
        ORDER BY effective_from LIMIT 1`,
      [empId, archiveDeptId],
    );
    if (rows.rows[0]) {
      await client.query(
        `UPDATE employee_assignments SET effective_from = $1, updated_at = now() WHERE id = $2`,
        [exclusionDate, rows.rows[0].id],
      );
    }
    // Лишние открытые архивные строки закрываем днём начала канонической.
    await client.query(
      `UPDATE employee_assignments SET effective_to = $1, updated_at = now()
        WHERE employee_id = $2 AND org_department_id = $3 AND effective_to IS NULL AND id <> $4`,
      [dismissalDate, empId, archiveDeptId, rows.rows[0]?.id ?? null],
    );
  } else if (plan.archiveAssignment === 'create') {
    await client.query(
      `INSERT INTO employee_assignments
         (employee_id, org_department_id, position_id, effective_from, effective_to,
          is_primary, assignment_type, change_reason, created_by)
       SELECT $1, $2, position_id, $3, NULL, true, 'main',
              'Восстановление увольнения после отката синком', NULL
         FROM employees WHERE id = $1`,
      [empId, archiveDeptId, exclusionDate],
    );
  }

  await client.query(
    `INSERT INTO public.fix_sync_reverted_backup_access (employee_id, access_id, org_department_id, is_active)
     SELECT employee_id, id, org_department_id, is_active
       FROM employee_department_access WHERE employee_id = $1 AND is_active`,
    [empId],
  );
  await client.query(
    `UPDATE employee_department_access SET is_active = false, updated_at = now()
      WHERE employee_id = $1 AND is_active`,
    [empId],
  );

  await client.query(
    `UPDATE employees
        SET employment_status = 'fired',
            dismissal_date = $1,
            excluded_from_timesheet = true,
            excluded_from_timesheet_date = $2,
            org_department_id = $3,
            department_locked = false,
            dismissal_apply_started_at = NULL,
            updated_at = now()
      WHERE id = $4`,
    [dismissalDate, exclusionDate, archiveDeptId, empId],
  );

  await client.query(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
     VALUES (NULL, 'FIX_SYNC_REVERTED_DISMISSAL', 'employee', $1, $2::jsonb)`,
    [String(empId), JSON.stringify({
      dismissal_date: dismissalDate,
      excluded_from_timesheet_date: exclusionDate,
      assignment_actions: plan.assignmentActions,
      archive_assignment: plan.archiveAssignment,
      source: 'fix-sync-reverted-dismissals',
    })],
  );

  // Постусловия — внутри транзакции: нарушение откатывает сотрудника целиком.
  const post = await client.query<{
    status: string; dis: string | null; excl: string | null; dept: string | null;
    open_archive: string; open_outside: string; overlaps: string; active_access: string;
  }>(
    `SELECT e.employment_status AS status, e.dismissal_date::text AS dis,
            e.excluded_from_timesheet_date::text AS excl, e.org_department_id::text AS dept,
            (SELECT count(*) FROM employee_assignments a
              WHERE a.employee_id = e.id AND a.effective_to IS NULL AND a.org_department_id = $2)::text AS open_archive,
            (SELECT count(*) FROM employee_assignments a
              WHERE a.employee_id = e.id AND a.effective_to IS NULL AND a.org_department_id <> $2)::text AS open_outside,
            (SELECT count(*) FROM employee_assignments a
               JOIN employee_assignments b ON b.employee_id = a.employee_id AND b.id <> a.id
              WHERE a.employee_id = e.id
                AND a.effective_from <= COALESCE(b.effective_to, 'infinity'::date)
                AND b.effective_from <= COALESCE(a.effective_to, 'infinity'::date))::text AS overlaps,
            (SELECT count(*) FROM employee_department_access x
              WHERE x.employee_id = e.id AND x.is_active)::text AS active_access
       FROM employees e WHERE e.id = $1`,
    [empId, archiveDeptId],
  );
  const p = post.rows[0];
  const problems: string[] = [];
  if (p.status !== 'fired') problems.push(`status=${p.status}`);
  if (p.dis !== dismissalDate) problems.push(`dismissal_date=${p.dis}`);
  if (p.excl !== exclusionDate) problems.push(`excluded_from_timesheet_date=${p.excl}`);
  if (p.dept !== archiveDeptId) problems.push(`org_department_id=${p.dept}`);
  if (p.open_archive !== '1') problems.push(`открытых архивных назначений: ${p.open_archive}`);
  if (p.open_outside !== '0') problems.push(`открытых назначений вне архива: ${p.open_outside}`);
  if (p.overlaps !== '0') problems.push(`пересечений периодов: ${p.overlaps}`);
  if (p.active_access !== '0') problems.push(`активных доступов: ${p.active_access}`);
  if (problems.length > 0) {
    throw new Error(`Постусловия не выполнены для ${empId}: ${problems.join(', ')}`);
  }
}

async function main() {
  const fileArg = process.argv.find(a => a.startsWith('--file='));
  const mode = process.argv.includes('--yes') ? 'apply' : process.argv.includes('--check') ? 'check' : null;
  if (!fileArg || !mode) {
    console.log('Использование: --file=review.json --check | --yes');
    process.exit(1);
  }
  const decisions = await loadDecisions(path.resolve(process.cwd(), fileArg.slice('--file='.length)));

  const { getPool } = await import('../src/config/postgres.js');
  const client = await getPool().connect();

  const applied: IPlan[] = [];
  const skipped: IPlan[] = [];
  const failed: Array<{ employeeId: number; error: string }> = [];
  const sigurQueue: Array<{ employeeId: number; sigurEmployeeId: number }> = [];

  try {
    const who = await client.query<{ current_user: string; db: string }>(
      'SELECT current_user, current_database() AS db',
    );
    console.log(`Подключение: user=${who.rows[0].current_user}, db=${who.rows[0].db}`);

    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked', [SCRIPT_LOCK_KEY],
    );
    if (!lock.rows[0].locked) throw new Error('Скрипт уже выполняется другим процессом');

    if (mode === 'apply') await client.query(BACKUP_DDL);

    const archiveDeptId = await resolveArchiveDepartmentId(client);
    console.log(`Архивный отдел: ${archiveDeptId}`);
    console.log(`Решений во входном файле: ${decisions.length}`);

    for (const decision of decisions) {
      try {
        await client.query('BEGIN');
        const plan = await buildPlan(client, decision, archiveDeptId);
        if (plan.skipReason || plan.outcome === 'unconfirmed') {
          await client.query('ROLLBACK');
          skipped.push(plan);
          continue;
        }
        if (mode === 'check') {
          await client.query('ROLLBACK');
          applied.push(plan);
          continue;
        }
        await applyPlan(client, plan, archiveDeptId);
        await client.query('COMMIT');
        applied.push(plan);
        if (plan.outcome === 'confirmed_fired' && plan.sigurEmployeeId) {
          sigurQueue.push({ employeeId: plan.employeeId, sigurEmployeeId: plan.sigurEmployeeId });
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        failed.push({ employeeId: decision.employeeId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await client.query('SELECT pg_advisory_unlock($1)', [SCRIPT_LOCK_KEY]);
  } finally {
    client.release();
  }

  console.log('\n=== ЛОКАЛЬНАЯ ЧАСТЬ ===');
  console.log(`${mode === 'check' ? 'К применению' : 'Применено'}: ${applied.length}`);
  for (const p of applied) {
    console.log(`  ${p.employeeId} ${p.fullName ?? ''} — ${p.outcome}`
      + (p.dismissalDate ? `, D=${p.dismissalDate}` : '')
      + (p.assignmentActions ? `, назначения: ${p.assignmentActions.map(a => a.kind).join(',') || 'нет'}` : '')
      + (p.archiveAssignment ? `, архив: ${p.archiveAssignment}` : ''));
  }
  console.log(`Пропущено: ${skipped.length}`);
  for (const p of skipped) console.log(`  ${p.employeeId} ${p.fullName ?? ''} — ${p.skipReason}`);
  if (failed.length > 0) {
    console.log(`Ошибки (изменения откачены): ${failed.length}`);
    for (const f of failed) console.log(`  ${f.employeeId} — ${f.error}`);
  }

  // Sigur — после коммита, вне транзакций и блокировок.
  const sigurFailures: Array<{ employeeId: number; sigurEmployeeId: number; error: string }> = [];
  if (mode === 'apply' && sigurQueue.length > 0) {
    console.log('\n=== SIGUR: перенос в архив + блокировка ===');
    const { sigurService } = await import('../src/services/sigur.service.js');
    const { settingsService } = await import('../src/services/settings.service.js');
    const archiveSigurId = (await settingsService.getSigurConnectionSettings()).archiveDepartmentId;
    if (!archiveSigurId) {
      console.log('sigur_archive_department_id не задан — перенос в Sigur пропущен целиком.');
      sigurQueue.forEach(item => sigurFailures.push({ ...item, error: 'archive department not configured' }));
    } else {
      for (const item of sigurQueue) {
        try {
          await sigurService.updateEmployee(item.sigurEmployeeId, { departmentId: archiveSigurId });
          await sigurService.blockEmployee(item.sigurEmployeeId);
          console.log(`  ${item.employeeId} (sigurId=${item.sigurEmployeeId}) — перенесён и заблокирован`);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          sigurFailures.push({ ...item, error });
          console.log(`  ${item.employeeId} (sigurId=${item.sigurEmployeeId}) — ОШИБКА: ${error}`);
        }
      }
    }
  }

  if (mode === 'apply') console.log(RESTORE_HINT);

  if (sigurFailures.length > 0) {
    console.log('\n=== RETRY-ОТЧЁТ SIGUR ===');
    console.log(JSON.stringify(sigurFailures, null, 2));
  }

  const exitCode = failed.length > 0 || sigurFailures.length > 0 ? 1 : 0;
  process.exit(exitCode);
}

// Прямой запуск (не импорт из тестов).
if (process.argv[1] && process.argv[1].includes('fix-sync-reverted-dismissals')) {
  main().catch(err => {
    console.error('Ошибка:', err?.stack ?? err?.message ?? err);
    process.exit(1);
  });
}
