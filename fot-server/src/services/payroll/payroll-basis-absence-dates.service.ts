/**
 * Даты отсутствий в сохранённой основе расчёта (миграция 339) — дозаполнение новой revision. Основа до 339 хранит
 * отсутствия только счётчиками (absence_days), а дни «Квартиры» (630 ₽ × дни без отпуска и больничного) требуют дат.
 *
 * Кандидаты — последние revision месяцев с fromMonth, где absence_dates нет, а отсутствия есть (без отсутствий
 * NULL расчёт и так читает как «дат нет»). Основа редакции пересобирается из её payload (buildPayrollBasisDrafts);
 * берутся только даты отсутствий, и только если их число по каждому статусу совпало с сохранёнными счётчиками —
 * иначе основа пропускается и попадает в отчёт. Пишется копия прежней revision с датами: остальные поля и качество —
 * прежние, reason = 'backfill'. Повторный запуск — без эффекта. Запуск — scripts/backfill-payroll-basis-absence-dates.ts.
 */
import { pool, query, withTransaction, type DbExecutor } from '../../config/postgres.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';
import {
  buildPayrollBasisDrafts,
  computeBasisHash,
  PAYROLL_ABSENCE_STATUSES,
  type IPayrollBasisDraft,
  type PayrollAbsenceDates,
  type PayrollAbsenceDays,
} from './payroll-basis.service.js';

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
  absence_days: Partial<PayrollAbsenceDays>;
  overtime_minutes: Record<string, number>;
}

export interface IAbsenceDatesSkip {
  versionId: number;
  employeeId: number;
  fullName: string | null;
  month: string;
  /** Счётчики основы и число дат пересборки по статусам. */
  stored: Partial<PayrollAbsenceDays>;
  rebuilt: PayrollAbsenceDays | null;
}

export interface IAbsenceDatesResult {
  candidates: number;
  /** Основ, которым будут (записаны) даты. */
  matched: number;
  /** Записано revision (только при apply). */
  written: number;
  skipped: IAbsenceDatesSkip[];
  failedVersions: number[];
}

const CANDIDATES_SQL = `SELECT b.version_id::text AS version_id, b.employee_id, e.full_name,
            to_char(b.month, 'YYYY-MM-DD') AS month, b.revision, b.norm_days, b.norm_minutes,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.workday_dates) d ORDER BY d) AS workday_dates,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.dayoff_dates) d ORDER BY d) AS dayoff_dates,
            b.absence_days, b.overtime_minutes
       FROM (
         SELECT DISTINCT ON (version_id, employee_id, month) *
           FROM timesheet_version_payroll_basis
          WHERE month >= $1::date
          ORDER BY version_id, employee_id, month, revision DESC
       ) b
       LEFT JOIN employees e ON e.id = b.employee_id
      WHERE b.absence_dates IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(b.absence_days) a WHERE a.value::int > 0)
      ORDER BY b.version_id, b.employee_id, b.month`;

const countsOf = (dates: PayrollAbsenceDates): PayrollAbsenceDays => Object.fromEntries(
  PAYROLL_ABSENCE_STATUSES.map(status => [status, dates[status].length]),
) as PayrollAbsenceDays;

/** Число дат по каждому статусу = сохранённый счётчик. */
export const absenceCountsMatch = (stored: Partial<PayrollAbsenceDays>, dates: PayrollAbsenceDates): boolean => (
  PAYROLL_ABSENCE_STATUSES.every(status => Number(stored[status] ?? 0) === dates[status].length)
);

export const backfillPayrollBasisAbsenceDates = async (options: {
  apply: boolean;
  /** YYYY-MM: месяцы основы с него. */
  fromMonth: string;
  /** Сборка основы редакции; по умолчанию — та же, что при закрытии. */
  rebuild?: (exec: DbExecutor, payload: ITimesheetVersionPayload) => Promise<IPayrollBasisDraft[]>;
  onVersionError?: (versionId: number, error: unknown) => void;
}): Promise<IAbsenceDatesResult> => {
  const rebuild = options.rebuild ?? buildPayrollBasisDrafts;
  const latest = (await query<IBasisRow>(CANDIDATES_SQL, [`${options.fromMonth}-01`]))
    .map(row => ({ ...row, employee_id: Number(row.employee_id), revision: Number(row.revision) }));

  const byVersion = new Map<number, IBasisRow[]>();
  for (const row of latest) {
    const versionId = Number(row.version_id);
    byVersion.set(versionId, [...(byVersion.get(versionId) ?? []), row]);
  }

  const skipped: IAbsenceDatesSkip[] = [];
  const failedVersions: number[] = [];
  let matched = 0;
  let written = 0;
  for (const [versionId, rows] of byVersion) {
    try {
      const payload = (await query<{ payload: ITimesheetVersionPayload | null }>(
        'SELECT payload FROM timesheet_versions WHERE id = $1',
        [versionId],
      ))[0]?.payload;
      if (!payload) continue;
      const drafts = new Map((await rebuild(pool(), payload)).map(draft => [`${draft.employeeId}|${draft.month}`, draft]));

      const fixes: Array<{ row: IBasisRow; dates: PayrollAbsenceDates; hash: string }> = [];
      for (const row of rows) {
        const dates = drafts.get(`${row.employee_id}|${row.month}`)?.absenceDates ?? null;
        if (!dates || !absenceCountsMatch(row.absence_days, dates)) {
          skipped.push({
            versionId, employeeId: row.employee_id, fullName: row.full_name, month: row.month.slice(0, 7),
            stored: row.absence_days, rebuilt: dates ? countsOf(dates) : null,
          });
          continue;
        }
        const hash = computeBasisHash({
          employeeId: row.employee_id,
          month: row.month,
          normDays: row.norm_days === null ? null : Number(row.norm_days),
          normMinutes: row.norm_minutes === null ? null : Number(row.norm_minutes),
          workdayDates: row.workday_dates,
          dayoffDates: row.dayoff_dates,
          absenceDays: { ...countsOf(dates) },
          absenceDates: dates,
          overtimeMinutes: row.overtime_minutes,
        });
        fixes.push({ row, dates, hash });
      }
      matched += fixes.length;
      if (!options.apply || fixes.length === 0) continue;

      written += await withTransaction(async client => {
        let count = 0;
        for (const { row, dates, hash } of fixes) {
          // Копия прежней revision с датами; ON CONFLICT — параллельный запуск уже записал.
          const result = await client.query(
            `INSERT INTO timesheet_version_payroll_basis (
               version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
               workday_dates, dayoff_dates, absence_days, absence_dates, overtime_minutes, quality, reason
             )
             SELECT b.version_id, b.employee_id, b.month, b.revision + 1, $5, b.norm_days, b.norm_minutes,
                    b.workday_dates, b.dayoff_dates, b.absence_days, $6::jsonb, b.overtime_minutes, b.quality, 'backfill'
               FROM timesheet_version_payroll_basis b
              WHERE b.version_id = $1 AND b.employee_id = $2 AND b.month = $3::date AND b.revision = $4
                AND b.absence_dates IS NULL
             ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
            [versionId, row.employee_id, row.month, row.revision, hash, JSON.stringify(dates)],
          );
          count += result.rowCount ?? 0;
        }
        return count;
      });
    } catch (error) {
      failedVersions.push(versionId);
      options.onVersionError?.(versionId, error);
    }
  }

  return { candidates: latest.length, matched, written, skipped, failedVersions };
};
