/**
 * Основа расчёта месяца сотрудника из закрытых подач (миграция 330). Берутся последние редакции подач
 * в статусе approved под замком (unlocked_at IS NULL), задевающих месяц, и в каждой — последняя revision основы
 * сотрудника. День сотрудника принадлежит одной подаче (владение днём версии), поэтому дни подач складываются.
 *
 * Месяц закрыт, только если периоды таких подач покрывают весь период сотрудника в месяце (с приёма по отсечку
 * увольнения) и нормы основ совпадают. Иначе — not_closed: суммы нет, дни закрытой половины с живым табелем
 * не смешиваются. Подачу открыли — она выпадает из выборки, месяц снова не закрыт.
 *
 * Дни подач бригады собраны ещё и по бригадам: их оплачивает доля «Выработки» по КТУ (brigade-salary), а не оклад.
 */
import { query } from '../../config/postgres.js';
import { emptyAbsenceDays, PAYROLL_ABSENCE_STATUSES, type PayrollAbsenceDays, type PayrollBasisQuality } from './payroll-basis.service.js';

/** Основа одной подачи: её период в месяце и дни сотрудника в ней. */
export interface IMonthBasisSource {
  basisId: number;
  versionId: number;
  coverFrom: string;
  coverTo: string;
  normDays: number | null;
  normMinutes: number | null;
  workdayDates: string[];
  dayoffDates: string[];
  absenceDays: Partial<PayrollAbsenceDays>;
  overtimeMinutes: Record<string, number>;
  quality: PayrollBasisQuality;
  /** Отдел подачи; у персональной — null. */
  departmentId: string | null;
  isBrigade: boolean;
}

/** Дни сотрудника в подачах одной бригады за месяц. */
export interface IMonthBrigadeDays {
  departmentId: string;
  workdayDates: string[];
  dayoffDates: string[];
}

export type MonthBasisNotClosedReason = 'not_covered' | 'norm_conflict';

export interface IClosedMonthBasis {
  state: 'closed';
  /** reconstructed — хоть одна основа дозаполнена по нынешним графикам. */
  quality: PayrollBasisQuality;
  basisIds: number[];
  versionIds: number[];
  normDays: number | null;
  normMinutes: number | null;
  workdayDates: string[];
  dayoffDates: string[];
  absenceDays: PayrollAbsenceDays;
  /** Переработка в будни по корректировкам: дата → минуты. */
  overtimeMinutes: Record<string, number>;
  /** Те же дни подач бригад — по бригадам. */
  brigades: IMonthBrigadeDays[];
}

export type MonthBasis = IClosedMonthBasis | { state: 'not_closed'; reason: MonthBasisNotClosedReason };

const nextIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/** Периоды подач покрывают [from, to] целиком. */
export const coversPeriod = (
  sources: ReadonlyArray<{ coverFrom: string; coverTo: string }>,
  period: { from: string; to: string },
): boolean => {
  let reached = period.from;
  const sorted = [...sources].sort((a, b) => a.coverFrom.localeCompare(b.coverFrom));
  for (const source of sorted) {
    if (source.coverFrom > reached) return false;
    if (source.coverTo >= reached) reached = nextIsoDay(source.coverTo);
    if (reached > period.to) return true;
  }
  return reached > period.to;
};

/** Основа месяца из основ подач — правила в шапке файла. */
export const assembleMonthBasis = (
  sources: readonly IMonthBasisSource[],
  period: { from: string; to: string },
): MonthBasis => {
  if (sources.length === 0 || !coversPeriod(sources, period)) return { state: 'not_closed', reason: 'not_covered' };
  const norms = new Set(sources.map(source => source.normDays).filter((norm): norm is number => norm !== null));
  const normMinutes = new Set(sources.map(source => source.normMinutes).filter((norm): norm is number => norm !== null));
  if (norms.size > 1 || normMinutes.size > 1) return { state: 'not_closed', reason: 'norm_conflict' };

  const inPeriod = (date: string): boolean => date >= period.from && date <= period.to;
  const brigades = new Map<string, IMonthBrigadeDays>();
  for (const source of sources) {
    if (!source.isBrigade || !source.departmentId) continue;
    const entry = brigades.get(source.departmentId) ?? { departmentId: source.departmentId, workdayDates: [], dayoffDates: [] };
    entry.workdayDates.push(...source.workdayDates.filter(inPeriod));
    entry.dayoffDates.push(...source.dayoffDates.filter(inPeriod));
    brigades.set(source.departmentId, entry);
  }
  const absenceDays = emptyAbsenceDays();
  const overtimeMinutes: Record<string, number> = {};
  for (const source of sources) {
    for (const status of PAYROLL_ABSENCE_STATUSES) absenceDays[status] += Number(source.absenceDays[status] ?? 0);
    for (const [date, minutes] of Object.entries(source.overtimeMinutes)) {
      if (inPeriod(date)) overtimeMinutes[date] = Number(minutes);
    }
  }
  return {
    state: 'closed',
    quality: sources.some(source => source.quality === 'reconstructed') ? 'reconstructed' : 'materialized',
    basisIds: sources.map(source => source.basisId).sort((a, b) => a - b),
    versionIds: [...new Set(sources.map(source => source.versionId))].sort((a, b) => a - b),
    normDays: norms.size === 1 ? [...norms][0] : null,
    normMinutes: normMinutes.size === 1 ? [...normMinutes][0] : null,
    workdayDates: sources.flatMap(source => source.workdayDates).filter(inPeriod).sort(),
    dayoffDates: sources.flatMap(source => source.dayoffDates).filter(inPeriod).sort(),
    absenceDays,
    overtimeMinutes,
    brigades: [...brigades.values()].map(entry => ({
      ...entry,
      workdayDates: entry.workdayDates.sort(),
      dayoffDates: entry.dayoffDates.sort(),
    })),
  };
};

interface IBasisSourceRow {
  basis_id: string;
  version_id: string;
  employee_id: number;
  cover_from: string;
  cover_to: string;
  norm_days: number | null;
  norm_minutes: number | null;
  overtime_minutes: Record<string, number> | null;
  workday_dates: string[] | null;
  dayoff_dates: string[] | null;
  absence_days: Partial<PayrollAbsenceDays> | null;
  quality: PayrollBasisQuality;
  department_id: string | null;
  is_brigade: boolean;
}

/** Основы закрытых подач месяца YYYY-MM по сотрудникам. */
export const loadMonthBasisSources = async (
  employeeIds: readonly number[],
  month: string,
): Promise<Map<number, IMonthBasisSource[]>> => {
  const result = new Map<number, IMonthBasisSource[]>();
  if (employeeIds.length === 0) return result;
  const rows = await query<IBasisSourceRow>(
    `SELECT b.id::text AS basis_id, v.id::text AS version_id, b.employee_id,
            to_char(GREATEST(a.start_date, $2::date), 'YYYY-MM-DD') AS cover_from,
            to_char(LEAST(a.end_date, ($2::date + INTERVAL '1 month - 1 day')::date), 'YYYY-MM-DD') AS cover_to,
            b.norm_days,
            b.norm_minutes,
            b.overtime_minutes,
            b.workday_dates::text[] AS workday_dates,
            b.dayoff_dates::text[] AS dayoff_dates,
            b.absence_days,
            b.quality,
            v.department_id::text AS department_id,
            COALESCE(d.kind = 'brigade', false) AS is_brigade
       FROM timesheet_approvals a
       CROSS JOIN LATERAL (
         SELECT tv.id, tv.department_id FROM timesheet_versions tv
          WHERE tv.approval_id = a.id
          ORDER BY tv.revision DESC
          LIMIT 1
       ) v
       JOIN LATERAL (
         SELECT DISTINCT ON (x.employee_id) x.*
           FROM timesheet_version_payroll_basis x
          WHERE x.version_id = v.id
            AND x.month = $2::date
            AND x.employee_id = ANY($1::int[])
          ORDER BY x.employee_id, x.revision DESC
       ) b ON true
       LEFT JOIN org_departments d ON d.id = v.department_id
      WHERE a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.start_date <= ($2::date + INTERVAL '1 month - 1 day')::date
        AND a.end_date >= $2::date`,
    [[...employeeIds], `${month}-01`],
  );
  for (const row of rows ?? []) {
    const source: IMonthBasisSource = {
      basisId: Number(row.basis_id),
      versionId: Number(row.version_id),
      coverFrom: row.cover_from,
      coverTo: row.cover_to,
      normDays: row.norm_days === null ? null : Number(row.norm_days),
      normMinutes: row.norm_minutes === null || row.norm_minutes === undefined ? null : Number(row.norm_minutes),
      overtimeMinutes: row.overtime_minutes ?? {},
      workdayDates: row.workday_dates ?? [],
      dayoffDates: row.dayoff_dates ?? [],
      absenceDays: row.absence_days ?? {},
      quality: row.quality,
      departmentId: row.department_id ?? null,
      isBrigade: row.is_brigade === true,
    };
    const employeeId = Number(row.employee_id);
    const list = result.get(employeeId);
    if (list) list.push(source);
    else result.set(employeeId, [source]);
  }
  return result;
};
