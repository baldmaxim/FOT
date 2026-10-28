/**
 * Переработка в будни в сохранённой основе расчёта (миграция 331) — по порогу не ниже дня производственного
 * календаря: 8 ч, предпраздничный 7 ч (решение пользователя 27.10.2026, payroll-basis.service.ts). До правки порогом
 * была норма дня графика, и короткая пятница (7 ч) с правкой «8» давала час переработки.
 *
 * Основа неизменяема — исправление пишется новой revision. Берётся последняя revision каждой основы с переработкой,
 * основа редакции пересобирается новым правилом, и у каждого дня остаётся меньшее из прежних и новых минут: часы
 * только уходят, дрейф графиков после закрытия их не добавит. Остальные поля и качество (materialized /
 * reconstructed) — прежние, reason = 'backfill'. Повторный запуск — без эффекта. Запуск —
 * scripts/fix-payroll-basis-overtime.ts.
 */
import { pool, query, withTransaction, type DbExecutor } from '../../config/postgres.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';
import {
  buildPayrollBasisDrafts,
  computeBasisHash,
  type IPayrollBasisDraft,
  type PayrollAbsenceDays,
  type PayrollBasisQuality,
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
  absence_days: PayrollAbsenceDays;
  overtime_minutes: Record<string, number>;
  quality: PayrollBasisQuality;
}

export interface IOvertimeFixMonth {
  /** YYYY-MM. */
  month: string;
  rows: number;
  people: number;
  minutesBefore: number;
  minutesAfter: number;
}

export interface IOvertimeFixSample {
  employeeId: number;
  fullName: string | null;
  month: string;
  versionId: number;
  before: Record<string, number>;
  after: Record<string, number>;
}

export interface IOvertimeFixResult {
  /** Основ с переработкой (последние revision). */
  candidates: number;
  /** Основ, у которых переработка уменьшилась. */
  changed: number;
  /** Записано revision (только при apply). */
  written: number;
  failedVersions: number[];
  months: IOvertimeFixMonth[];
  samples: IOvertimeFixSample[];
}

/** Переработка дня — меньшее из прежней и пересобранной; дни без минут не остаются. */
export const reduceOvertime = (
  previous: Readonly<Record<string, number>>,
  rebuilt: Readonly<Record<string, number>>,
): Record<string, number> => Object.fromEntries(Object.entries(previous)
  .map(([date, minutes]) => [date, Math.min(minutes, rebuilt[date] ?? 0)] as const)
  .filter(([, minutes]) => minutes > 0));

const sameOvertime = (a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean => (
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([date, minutes]) => b[date] === minutes)
);

const sumMinutes = (minutes: Readonly<Record<string, number>>): number => (
  Object.values(minutes).reduce((sum, value) => sum + value, 0)
);

export const fixPayrollBasisOvertime = async (options: {
  apply: boolean;
  /** Сотрудники, у которых в отчёт идут дни поимённо. */
  sampleEmployeeIds?: ReadonlySet<number>;
  /** Сборка основы редакции; по умолчанию — та же, что при закрытии. */
  rebuild?: (exec: DbExecutor, payload: ITimesheetVersionPayload) => Promise<IPayrollBasisDraft[]>;
  onVersionError?: (versionId: number, error: unknown) => void;
}): Promise<IOvertimeFixResult> => {
  const rebuild = options.rebuild ?? buildPayrollBasisDrafts;
  const latest = (await query<IBasisRow>(
    `SELECT b.version_id::text AS version_id, b.employee_id, e.full_name, to_char(b.month, 'YYYY-MM-DD') AS month,
            b.revision, b.norm_days, b.norm_minutes,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.workday_dates) d ORDER BY d) AS workday_dates,
            ARRAY(SELECT to_char(d, 'YYYY-MM-DD') FROM unnest(b.dayoff_dates) d ORDER BY d) AS dayoff_dates,
            b.absence_days, b.overtime_minutes, b.quality
       FROM (
         SELECT DISTINCT ON (version_id, employee_id, month) *
           FROM timesheet_version_payroll_basis
          ORDER BY version_id, employee_id, month, revision DESC
       ) b
       LEFT JOIN employees e ON e.id = b.employee_id
      WHERE b.overtime_minutes <> '{}'::jsonb
      ORDER BY b.version_id, b.employee_id, b.month`,
  )).map(row => ({ ...row, employee_id: Number(row.employee_id), revision: Number(row.revision) }));

  const byVersion = new Map<number, IBasisRow[]>();
  for (const row of latest) {
    const versionId = Number(row.version_id);
    byVersion.set(versionId, [...(byVersion.get(versionId) ?? []), row]);
  }

  const months = new Map<string, { rows: number; people: Set<number>; before: number; after: number }>();
  const samples: IOvertimeFixSample[] = [];
  const failedVersions: number[] = [];
  let changed = 0;
  let written = 0;
  for (const [versionId, rows] of byVersion) {
    try {
      const payload = (await query<{ payload: ITimesheetVersionPayload | null }>(
        'SELECT payload FROM timesheet_versions WHERE id = $1',
        [versionId],
      ))[0]?.payload;
      if (!payload) continue;
      const drafts = new Map((await rebuild(pool(), payload)).map(draft => [`${draft.employeeId}|${draft.month}`, draft]));

      const fixes: Array<{ row: IBasisRow; overtime: Record<string, number>; hash: string }> = [];
      for (const row of rows) {
        const overtime = reduceOvertime(row.overtime_minutes, drafts.get(`${row.employee_id}|${row.month}`)?.overtimeMinutes ?? {});
        if (sameOvertime(overtime, row.overtime_minutes)) continue;
        const draft: IPayrollBasisDraft = {
          employeeId: row.employee_id,
          month: row.month,
          normDays: row.norm_days === null ? null : Number(row.norm_days),
          normMinutes: row.norm_minutes === null ? null : Number(row.norm_minutes),
          workdayDates: row.workday_dates,
          dayoffDates: row.dayoff_dates,
          absenceDays: row.absence_days,
          overtimeMinutes: overtime,
        };
        fixes.push({ row, overtime, hash: computeBasisHash(draft) });

        const month = row.month.slice(0, 7);
        const stat = months.get(month) ?? { rows: 0, people: new Set<number>(), before: 0, after: 0 };
        stat.rows += 1;
        stat.people.add(row.employee_id);
        stat.before += sumMinutes(row.overtime_minutes);
        stat.after += sumMinutes(overtime);
        months.set(month, stat);
        if (options.sampleEmployeeIds?.has(row.employee_id)) {
          samples.push({
            employeeId: row.employee_id, fullName: row.full_name, month, versionId,
            before: row.overtime_minutes, after: overtime,
          });
        }
      }
      changed += fixes.length;
      if (!options.apply || fixes.length === 0) continue;

      written += await withTransaction(async client => {
        let count = 0;
        for (const { row, overtime, hash } of fixes) {
          // Копия прежней revision с новой переработкой; ON CONFLICT — параллельный запуск уже записал.
          const result = await client.query(
            `INSERT INTO timesheet_version_payroll_basis (
               version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
               workday_dates, dayoff_dates, absence_days, overtime_minutes, quality, reason
             )
             SELECT b.version_id, b.employee_id, b.month, b.revision + 1, $5, b.norm_days, b.norm_minutes,
                    b.workday_dates, b.dayoff_dates, b.absence_days, $6::jsonb, b.quality, 'backfill'
               FROM timesheet_version_payroll_basis b
              WHERE b.version_id = $1 AND b.employee_id = $2 AND b.month = $3::date AND b.revision = $4
             ON CONFLICT (version_id, employee_id, month, revision) DO NOTHING`,
            [versionId, row.employee_id, row.month, row.revision, hash, JSON.stringify(overtime)],
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

  return {
    candidates: latest.length,
    changed,
    written,
    failedVersions,
    months: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([month, stat]) => ({
      month, rows: stat.rows, people: stat.people.size, minutesBefore: stat.before, minutesAfter: stat.after,
    })),
    samples,
  };
};
