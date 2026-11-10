/**
 * «Режим табелирования» → сотрудник «По графику» (миграция 358).
 *
 * Отмеченному сотруднику расчёт табеля (buildAttendanceEntries) в рабочие по графику дни ставит
 * норму дня без СКУД. Период — строка employee_schedule_timesheet_periods [date_from, date_to].
 *
 * Запись идёт из окна, в одной транзакции с «Офисом» (timesheet-office.service.ts):
 *   • «Добавить» — с 1-го текущего месяца МСК, но не раньше дня после согласованной незакрытой
 *     подачи с этим сотрудником (согласованное не трогается), не раньше дня после прошлого периода,
 *     а если в этом месяце период закрыло увольнение — не раньше сегодняшнего дня;
 *   • «Снять» — период закрывается max(конец прошлого месяца, конец согласованной подачи); если
 *     от периода ничего не остаётся — строка удаляется.
 * Согласованные дни и прошлые месяцы не меняются — редакции 1С не пересобираются.
 * Повтор (уже отмечен / уже снят) ничего не пишет. Увольнение закрывает период триггером 358.
 */
import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { canWriteEmployeeInScope } from './data-scope.service.js';
import type { IOfficeAuditEntry } from './timesheet-office-rule.js';
import { TimesheetOfficeError } from './timesheet-office-error.js';
import { maxIso, shiftIsoDay } from './timesheet-schedule-ranges.service.js';

export interface IScheduleModeChanges {
  add: number[];
  remove: number[];
}

interface IScheduleCheckRow {
  id: number | string;
  full_name: string | null;
  is_archived: boolean;
  employment_status: string | null;
  org_department_id: string | null;
  has_open: boolean;
}

const checkSql = (lock: boolean): string =>
  `SELECT e.id,
          e.full_name,
          e.is_archived,
          e.employment_status,
          e.org_department_id::text AS org_department_id,
          EXISTS (SELECT 1 FROM employee_schedule_timesheet_periods p
                   WHERE p.employee_id = e.id AND p.date_to IS NULL) AS has_open
     FROM employees e
    WHERE e.id = ANY($1::int[])
    ORDER BY e.id${lock ? '\n    FOR UPDATE OF e' : ''}`;

export interface IPreparedScheduleChanges {
  add: number[];
  /** Только те, у кого сейчас есть открытый период; остальное «Снять» — no-op. */
  remove: number[];
}

/** 400: «Добавить» — только работающему, не архивному, не подрядному. «Снять» — любому. */
export async function validateScheduleChanges(
  changes: IScheduleModeChanges,
  contractors: ReadonlySet<string>,
): Promise<IPreparedScheduleChanges> {
  const add = [...new Set(changes.add)].sort((a, b) => a - b);
  const remove = [...new Set(changes.remove)].sort((a, b) => a - b);
  const overlap = add.filter(id => remove.includes(id));
  if (overlap.length > 0) {
    throw new TimesheetOfficeError(400, 'TIMESHEET_OFFICE_INVALID', 'Один и тот же сотрудник в «Добавить» и «Снять»', overlap);
  }
  const ids = [...add, ...remove];
  if (ids.length === 0) return { add, remove };
  const rows = await query<IScheduleCheckRow>(checkSql(false), [ids]);
  const byId = new Map(rows.map(row => [Number(row.id), row]));
  const invalid = add.filter(id => {
    const row = byId.get(id);
    return !row || row.is_archived || row.employment_status !== 'active'
      || !row.org_department_id || contractors.has(row.org_department_id);
  });
  if (invalid.length > 0) {
    throw new TimesheetOfficeError(
      400, 'TIMESHEET_OFFICE_INVALID', 'Сотрудник не найден, в архиве, не работает или из подрядной организации', invalid,
    );
  }
  return { add, remove: remove.filter(id => byId.get(id)?.has_open === true) };
}

/** 403: id сотрудников вне скоупа записи. */
export async function deniedScheduleEmployees(
  req: AuthenticatedRequest,
  prepared: IPreparedScheduleChanges,
): Promise<number[]> {
  const denied: number[] = [];
  for (const id of [...prepared.add, ...prepared.remove]) {
    if (!(await canWriteEmployeeInScope(req, id))) denied.push(id);
  }
  return denied;
}

export interface IScheduleApplyResult {
  added: number;
  removed: number;
  audit: IOfficeAuditEntry[];
}

/** Конец последней согласованной незакрытой подачи текущего месяца — по сотрудникам. */
async function loadApprovedEnds(client: PoolClient, ids: readonly number[], monthStart: string): Promise<Map<number, string>> {
  const rows = (await client.query<{ employee_id: number | string; approved_end: string }>(
    `SELECT ae.employee_id, max(a.end_date)::text AS approved_end
       FROM timesheet_approvals a
       JOIN timesheet_approval_employees ae ON ae.approval_id = a.id
      WHERE a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.end_date >= $2::date
        AND ae.employee_id = ANY($1::bigint[])
      GROUP BY ae.employee_id`,
    [ids, monthStart],
  )).rows;
  return new Map(rows.map(row => [Number(row.employee_id), row.approved_end]));
}

/**
 * Запись в транзакции окна (лок режимов уже взят вызывающим). Сотрудники перечитываются
 * FOR UPDATE: увольнение (триггер 358) и «Добавить» не разойдутся. Возвращает аудит — его пишет
 * вызывающий вместе с аудитом «Офиса».
 */
export async function applyScheduleChanges(
  client: PoolClient,
  prepared: IPreparedScheduleChanges,
  actor: { userId: string; now: Date },
): Promise<IScheduleApplyResult> {
  const ids = [...new Set([...prepared.add, ...prepared.remove])].sort((a, b) => a - b);
  if (ids.length === 0) return { added: 0, removed: 0, audit: [] };

  const today = moscowTodayIso(actor.now);
  const monthStart = `${today.slice(0, 8)}01`;
  const locked = new Map(
    (await client.query<IScheduleCheckRow>(checkSql(true), [ids])).rows.map(row => [Number(row.id), row]),
  );
  const drifted = prepared.add.filter(id => {
    const row = locked.get(id);
    return !row || row.is_archived || row.employment_status !== 'active';
  });
  if (drifted.length > 0) {
    throw new TimesheetOfficeError(409, 'TIMESHEET_OFFICE_CHANGED', 'Состав изменился — обновите окно', drifted);
  }

  const approvedEnds = await loadApprovedEnds(client, ids, monthStart);
  const audit: IOfficeAuditEntry[] = [];

  const toAdd = prepared.add.filter(id => locked.get(id)?.has_open !== true);
  let added = 0;
  if (toAdd.length > 0) {
    const history = new Map((await client.query<{ employee_id: number | string; last_to: string | null; dismissed_this_month: boolean }>(
      `SELECT employee_id,
              max(date_to)::text AS last_to,
              bool_or(closed_reason = 'dismissal' AND date_to >= $2::date) AS dismissed_this_month
         FROM employee_schedule_timesheet_periods
        WHERE employee_id = ANY($1::int[])
        GROUP BY employee_id`,
      [toAdd, monthStart],
    )).rows.map(row => [Number(row.employee_id), row]));
    for (const id of toAdd) {
      const approvedEnd = approvedEnds.get(id);
      const past = history.get(id);
      const dateFrom = maxIso(
        monthStart,
        approvedEnd ? shiftIsoDay(approvedEnd, 1) : null,
        past?.last_to ? shiftIsoDay(past.last_to, 1) : null,
        past?.dismissed_this_month ? today : null,
      );
      const inserted = (await client.query<{ id: number | string }>(
        `INSERT INTO employee_schedule_timesheet_periods (employee_id, date_from, created_by)
         VALUES ($1::int, $2::date, $3::uuid)
         ON CONFLICT (employee_id) WHERE date_to IS NULL DO NOTHING
         RETURNING id`,
        [id, dateFrom, actor.userId],
      )).rows;
      if (inserted.length === 0) continue;
      added += 1;
      audit.push({
        entityType: 'employee',
        entityId: String(id),
        details: { employee_name: locked.get(id)?.full_name ?? null, via: 'schedule', action: 'add', date_from: dateFrom },
      });
    }
  }

  let removed = 0;
  if (prepared.remove.length > 0) {
    const open = (await client.query<{ id: number | string; employee_id: number | string; date_from: string }>(
      `SELECT id, employee_id, date_from::text AS date_from
         FROM employee_schedule_timesheet_periods
        WHERE employee_id = ANY($1::int[]) AND date_to IS NULL
        ORDER BY employee_id
        FOR UPDATE`,
      [prepared.remove],
    )).rows;
    for (const period of open) {
      const employeeId = Number(period.employee_id);
      const cut = maxIso(shiftIsoDay(monthStart, -1), approvedEnds.get(employeeId));
      if (cut < period.date_from) {
        await client.query('DELETE FROM employee_schedule_timesheet_periods WHERE id = $1', [period.id]);
      } else {
        await client.query(
          `UPDATE employee_schedule_timesheet_periods
              SET date_to = $2::date, closed_reason = 'manual', closed_by = $3::uuid, closed_at = now()
            WHERE id = $1`,
          [period.id, cut, actor.userId],
        );
      }
      removed += 1;
      audit.push({
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_name: locked.get(employeeId)?.full_name ?? null,
          via: 'schedule',
          action: 'remove',
          date_from: period.date_from,
          date_to: cut < period.date_from ? null : cut,
        },
      });
    }
  }

  return { added, removed, audit };
}
