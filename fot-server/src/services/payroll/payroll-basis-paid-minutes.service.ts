/**
 * Минуты к оплате в сохранённой основе расчёта — новой revision (миграция 344). Почасовую ставку могут назначить
 * задним числом на уже закрытый месяц, а в основе до 344 часов дня нет: без них расчёт оставил бы ⚠.
 *
 * Кандидаты — последние revision без paid_minutes с месяца fromMonth. Минуты — из дней редакции (payload) теми же
 * правилами, что при закрытии, но по графикам на дату запуска. Берутся только даты, уже стоящие в основе: даты и норма
 * основы не меняются, окладник этого не замечает. Дата основы, у которой минут не нашлось (график сменили), остаётся
 * без минут: у почасового это ⚠, а не догадка; такие основы считаются в отчёте. Качество основы прежнее.
 * Повторный запуск записанное не трогает.
 */
import { pool, query, withTransaction, type DbExecutor } from '../../config/postgres.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';
import {
  buildPayrollBasisDrafts,
  computeBasisHash,
  type IPayrollBasisDraft,
  type PayrollAbsenceDates,
  type PayrollAbsenceDays,
} from './payroll-basis.service.js';

interface IBasisRow {
  version_id: string;
  employee_id: number;
  month: string;
  revision: number;
  norm_days: number | null;
  norm_minutes: number | null;
  workday_dates: string[];
  dayoff_dates: string[];
  absence_days: PayrollAbsenceDays;
  absence_dates: PayrollAbsenceDates | null;
  overtime_minutes: Record<string, number>;
}

export interface IPaidMinutesBackfillResult {
  candidates: number;
  /** Основ, которым будут (записаны) минуты. */
  matched: number;
  /** Записано revision (только при apply). */
  written: number;
  /** Основ, где у части дат минут не нашлось. */
  uncovered: number;
  failedVersions: number[];
}

const CANDIDATES_SQL = `SELECT b.version_id::text AS version_id, b.employee_id,
            to_char(b.month, 'YYYY-MM-DD') AS month, b.revision, b.norm_days, b.norm_minutes,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.workday_dates) d ORDER BY d) AS workday_dates,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.dayoff_dates) d ORDER BY d) AS dayoff_dates,
            b.absence_days, b.absence_dates, b.overtime_minutes
       FROM (
         SELECT DISTINCT ON (version_id, employee_id, month) *
           FROM timesheet_version_payroll_basis
          WHERE month >= $1::date
          ORDER BY version_id, employee_id, month, revision DESC
       ) b
      WHERE b.paid_minutes IS NULL
      ORDER BY b.version_id, b.employee_id, b.month`;

/** Минуты только по датам основы. */
export const paidMinutesForStoredDates = (
  rebuilt: Readonly<Record<string, number>>,
  dates: readonly string[],
): { minutes: Record<string, number>; uncovered: number } => {
  const minutes: Record<string, number> = {};
  let uncovered = 0;
  for (const date of dates) {
    if (rebuilt[date] === undefined) uncovered += 1;
    else minutes[date] = rebuilt[date];
  }
  return { minutes, uncovered };
};

export const backfillPayrollBasisPaidMinutes = async (options: {
  apply: boolean;
  /** YYYY-MM: месяцы основы с него. */
  fromMonth: string;
  /** Сборка основы редакции; по умолчанию — та же, что при закрытии. */
  rebuild?: (exec: DbExecutor, payload: ITimesheetVersionPayload) => Promise<IPayrollBasisDraft[]>;
  onVersionError?: (versionId: number, error: unknown) => void;
}): Promise<IPaidMinutesBackfillResult> => {
  const rebuild = options.rebuild ?? buildPayrollBasisDrafts;
  const latest = (await query<IBasisRow>(CANDIDATES_SQL, [`${options.fromMonth}-01`]))
    .map(row => ({ ...row, employee_id: Number(row.employee_id), revision: Number(row.revision) }));

  const byVersion = new Map<number, IBasisRow[]>();
  for (const row of latest) {
    const versionId = Number(row.version_id);
    byVersion.set(versionId, [...(byVersion.get(versionId) ?? []), row]);
  }

  const failedVersions: number[] = [];
  let matched = 0;
  let written = 0;
  let uncovered = 0;
  for (const [versionId, rows] of byVersion) {
    try {
      const payload = (await query<{ payload: ITimesheetVersionPayload | null }>(
        'SELECT payload FROM timesheet_versions WHERE id = $1',
        [versionId],
      ))[0]?.payload;
      if (!payload) continue;
      const drafts = new Map((await rebuild(pool(), payload)).map(draft => [`${draft.employeeId}|${draft.month}`, draft]));

      const fixes: Array<{ row: IBasisRow; minutes: Record<string, number>; hash: string }> = [];
      for (const row of rows) {
        const draft = drafts.get(`${row.employee_id}|${row.month}`);
        if (!draft) continue;
        const stored = paidMinutesForStoredDates(draft.paidMinutes, [...row.workday_dates, ...row.dayoff_dates]);
        if (stored.uncovered > 0) uncovered += 1;
        fixes.push({
          row,
          minutes: stored.minutes,
          hash: computeBasisHash({
            employeeId: row.employee_id,
            month: row.month,
            normDays: row.norm_days === null ? null : Number(row.norm_days),
            normMinutes: row.norm_minutes === null ? null : Number(row.norm_minutes),
            workdayDates: row.workday_dates,
            dayoffDates: row.dayoff_dates,
            absenceDays: row.absence_days,
            absenceDates: row.absence_dates ?? null,
            overtimeMinutes: row.overtime_minutes,
            paidMinutes: stored.minutes,
          }),
        });
      }
      matched += fixes.length;
      if (!options.apply || fixes.length === 0) continue;

      written += await withTransaction(async client => {
        let count = 0;
        for (const { row, minutes, hash } of fixes) {
          // Копия прежней revision с минутами; ON CONFLICT — параллельный запуск уже записал.
          const result = await client.query(
            `INSERT INTO timesheet_version_payroll_basis (
               version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
               workday_dates, dayoff_dates, absence_days, absence_dates, overtime_minutes, paid_minutes, quality, reason
             )
             SELECT b.version_id, b.employee_id, b.month, b.revision + 1, $5, b.norm_days, b.norm_minutes,
                    b.workday_dates, b.dayoff_dates, b.absence_days, b.absence_dates, b.overtime_minutes, $6::jsonb,
                    b.quality, 'backfill'
               FROM timesheet_version_payroll_basis b
              WHERE b.version_id = $1 AND b.employee_id = $2 AND b.month = $3::date AND b.revision = $4
                AND b.paid_minutes IS NULL
             ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
            [versionId, row.employee_id, row.month, row.revision, hash, JSON.stringify(minutes)],
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

  return { candidates: latest.length, matched, written, uncovered, failedVersions };
};
