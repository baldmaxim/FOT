/**
 * Норма часов (norm_minutes) основ месяцев с окладом по часам (с ноября 2026, payroll-salary-hours.ts) — новой revision.
 * Нужна основам, закрытым до выкатки бэкенда с нормой графика: у них норма производственного календаря (ноябрь —
 * 159 ч), и у графика 10 ч почти весь месяц ушёл бы в переработку.
 *
 * schedule — норма по действующему правилу (countMonthNormMinutes: с ноября — норма графика), основа редакции
 * пересобирается из её payload по графикам на сейчас; calendar — откат: норма календаря, как до правки (без календаря —
 * норма графика, как и тогда). Берётся только последняя revision каждой пары редакция + сотрудник + месяц; пишется её
 * копия с новой нормой — остальные поля и качество прежние, reason = 'backfill'. Повторный запуск — без эффекта.
 *
 * Всё или ничего: не построилась основа или норма хоть у одной строки, упала хоть одна редакция — запись не делается
 * вовсе. Запись — одна транзакция на редакцию. Запуск — scripts/fix-payroll-basis-norm-minutes.ts.
 */
import { pool, query, withTransaction, type DbExecutor } from '../../config/postgres.js';
import type { IResolvedSchedule } from '../../types/index.js';
import { loadCalendarMonth, resolveSchedulesForPeriod } from '../schedule.service.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';
import {
  buildPayrollBasisDrafts,
  computeBasisHash,
  type IPayrollBasisDraft,
  type PayrollAbsenceDates,
  type PayrollAbsenceDays,
} from './payroll-basis.service.js';
import { SALARY_BY_HOURS_FROM } from './payroll-salary-hours.js';

export type NormFixMode = 'schedule' | 'calendar';

interface IBasisRow {
  version_id: string;
  employee_id: number;
  full_name: string | null;
  month: string;
  revision: number;
  norm_days: number | null;
  norm_minutes: number | null;
  workday_dates: string[];
  dayoff_dates: string[];
  absence_days: PayrollAbsenceDays;
  absence_dates: PayrollAbsenceDates | null;
  overtime_minutes: Record<string, number>;
  paid_minutes: Record<string, number> | null;
}

export interface INormFixChange {
  versionId: number;
  employeeId: number;
  fullName: string | null;
  /** YYYY-MM. */
  month: string;
  before: number | null;
  after: number;
  /** Графики месяца по датам: «2026-11-01..2026-11-15 <id>». */
  schedules: string[];
}

export interface INormFixProblem {
  versionId: number;
  employeeId: number | null;
  reason: string;
}

export interface INormFixResult {
  mode: NormFixMode;
  /** Основ-кандидатов (последние revision месяцев с окладом по часам). */
  candidates: number;
  changes: INormFixChange[];
  /** Не построилась основа или норма, упала редакция — при них запись не делается. */
  problems: INormFixProblem[];
  /** Записано revision (только при apply и без проблем). */
  written: number;
}

const CANDIDATES_SQL = `SELECT b.version_id::text AS version_id, b.employee_id, e.full_name,
            to_char(b.month, 'YYYY-MM-DD') AS month, b.revision, b.norm_days, b.norm_minutes,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.workday_dates) d ORDER BY d) AS workday_dates,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.dayoff_dates) d ORDER BY d) AS dayoff_dates,
            b.absence_days, b.absence_dates, b.overtime_minutes, b.paid_minutes
       FROM (SELECT DISTINCT ON (version_id, employee_id, month) *
               FROM timesheet_version_payroll_basis
              WHERE month >= $1::date
              ORDER BY version_id, employee_id, month, revision DESC) b
       LEFT JOIN employees e ON e.id = b.employee_id
      ORDER BY b.version_id, b.employee_id, b.month`;

/** Графики по датам — подряд идущие даты одного графика одной строкой. */
export const describeSchedules = (byDate: ReadonlyMap<string, IResolvedSchedule> | undefined): string[] => {
  const ranges: Array<{ from: string; to: string; id: string }> = [];
  for (const [date, schedule] of [...(byDate ?? new Map<string, IResolvedSchedule>())].sort(([a], [b]) => a.localeCompare(b))) {
    const id = schedule.name ? `${schedule.name} (${schedule.schedule_id})` : schedule.schedule_id;
    const last = ranges[ranges.length - 1];
    if (last && last.id === id) last.to = date;
    else ranges.push({ from: date, to: date, id });
  }
  return ranges.map(range => `${range.from}..${range.to} ${range.id}`);
};

const lastDayOf = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  return `${month.slice(0, 7)}-${String(new Date(year, mon, 0).getDate()).padStart(2, '0')}`;
};

export const fixPayrollBasisNormMinutes = async (options: {
  apply: boolean;
  mode?: NormFixMode;
  /** С какого месяца, YYYY-MM; по умолчанию — первый месяц оклада по часам. */
  fromMonth?: string;
  /** Сборка основы редакции; по умолчанию — та же, что при закрытии. */
  rebuild?: (exec: DbExecutor, payload: ITimesheetVersionPayload) => Promise<IPayrollBasisDraft[]>;
}): Promise<INormFixResult> => {
  const mode = options.mode ?? 'schedule';
  const fromMonth = options.fromMonth ?? SALARY_BY_HOURS_FROM;
  const rebuild = options.rebuild ?? buildPayrollBasisDrafts;
  const rows = (await query<IBasisRow>(CANDIDATES_SQL, [`${fromMonth}-01`]))
    .map(row => ({ ...row, employee_id: Number(row.employee_id), revision: Number(row.revision) }));
  const byVersion = new Map<number, IBasisRow[]>();
  for (const row of rows) {
    const versionId = Number(row.version_id);
    byVersion.set(versionId, [...(byVersion.get(versionId) ?? []), row]);
  }

  const calendarNorms = new Map<string, number | null>();
  const calendarNormOf = async (month: string): Promise<number | null> => {
    if (!calendarNorms.has(month)) {
      const [year, mon] = month.split('-').map(Number);
      const calendar = await loadCalendarMonth(year, mon);
      calendarNorms.set(month, calendar && Number(calendar.norm_hours) > 0 ? Math.round(Number(calendar.norm_hours) * 60) : null);
    }
    return calendarNorms.get(month) ?? null;
  };

  const changes: INormFixChange[] = [];
  const problems: INormFixProblem[] = [];
  const fixes = new Map<number, Array<{ row: IBasisRow; norm: number; hash: string }>>();
  for (const [versionId, versionRows] of byVersion) {
    try {
      const payload = (await query<{ payload: ITimesheetVersionPayload | null }>(
        'SELECT payload FROM timesheet_versions WHERE id = $1',
        [versionId],
      ))[0]?.payload;
      if (!payload) {
        problems.push({ versionId, employeeId: null, reason: 'нет payload редакции' });
        continue;
      }
      const drafts = new Map((await rebuild(pool(), payload)).map(draft => [`${draft.employeeId}|${draft.month}`, draft]));
      const versionFixes: Array<{ row: IBasisRow; norm: number; hash: string }> = [];
      for (const row of versionRows) {
        const draft = drafts.get(`${row.employee_id}|${row.month}`);
        const scheduleNorm = draft?.normMinutes ?? null;
        const norm = mode === 'calendar' ? (await calendarNormOf(row.month)) ?? scheduleNorm : scheduleNorm;
        if (!draft || norm === null) {
          problems.push({
            versionId, employeeId: row.employee_id, reason: draft ? 'норма не построилась (нет графика)' : 'основа не построилась',
          });
          continue;
        }
        const before = row.norm_minutes === null ? null : Number(row.norm_minutes);
        if (before === norm) continue;
        const hash = computeBasisHash({
          employeeId: row.employee_id,
          month: row.month,
          normDays: row.norm_days === null ? null : Number(row.norm_days),
          normMinutes: norm,
          workdayDates: row.workday_dates,
          dayoffDates: row.dayoff_dates,
          absenceDays: row.absence_days,
          absenceDates: row.absence_dates ?? null,
          overtimeMinutes: row.overtime_minutes,
          paidMinutes: row.paid_minutes,
        });
        versionFixes.push({ row, norm, hash });
      }
      if (versionFixes.length === 0) continue;
      fixes.set(versionId, versionFixes);
      // Графики по датам — для отчёта и ручной сверки до записи.
      for (const month of [...new Set(versionFixes.map(fix => fix.row.month))]) {
        const monthFixes = versionFixes.filter(fix => fix.row.month === month);
        const schedules = await resolveSchedulesForPeriod(
          monthFixes.map(fix => ({ id: fix.row.employee_id })), month, lastDayOf(month), pool(),
        );
        for (const { row, norm } of monthFixes) {
          changes.push({
            versionId,
            employeeId: row.employee_id,
            fullName: row.full_name,
            month: row.month.slice(0, 7),
            before: row.norm_minutes === null ? null : Number(row.norm_minutes),
            after: norm,
            schedules: describeSchedules(schedules.get(row.employee_id)),
          });
        }
      }
    } catch (error) {
      problems.push({ versionId, employeeId: null, reason: (error as Error).message });
    }
  }

  let written = 0;
  if (options.apply && problems.length === 0) {
    for (const [versionId, versionFixes] of fixes) {
      written += await withTransaction(async client => {
        let count = 0;
        for (const { row, norm, hash } of versionFixes) {
          // Копия последней revision с новой нормой; ON CONFLICT — параллельный запуск уже записал.
          const result = await client.query(
            `INSERT INTO timesheet_version_payroll_basis (
               version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
               workday_dates, dayoff_dates, absence_days, absence_dates, overtime_minutes, paid_minutes, quality, reason
             )
             SELECT b.version_id, b.employee_id, b.month, b.revision + 1, $5, b.norm_days, $6,
                    b.workday_dates, b.dayoff_dates, b.absence_days, b.absence_dates, b.overtime_minutes, b.paid_minutes,
                    b.quality, 'backfill'
               FROM timesheet_version_payroll_basis b
              WHERE b.version_id = $1 AND b.employee_id = $2 AND b.month = $3::date AND b.revision = $4
                AND NOT EXISTS (
                  SELECT 1 FROM timesheet_version_payroll_basis n
                   WHERE n.version_id = b.version_id AND n.employee_id = b.employee_id AND n.month = b.month
                     AND n.revision > b.revision
                )
             ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
            [versionId, row.employee_id, row.month, row.revision, hash, norm],
          );
          count += result.rowCount ?? 0;
        }
        return count;
      });
    }
  }

  return { mode, candidates: rows.length, changes, problems, written };
};
