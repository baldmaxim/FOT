/**
 * Основа расчёта месяца сотрудника из закрытых подач (миграция 330). Берутся последние редакции подач
 * в статусе approved под замком (unlocked_at IS NULL), задевающих месяц, и в каждой — последняя revision основы
 * сотрудника. Дни подач складываются без повторов: дата в двух подачах (отдел и персональная, июль–август 2026)
 * оплачивается один раз.
 *
 * Месяц закрыт, только если каждая дата периода сотрудника в месяце (с приёма по отсечку увольнения) лежит в подаче,
 * где он числится и которой эта дата принадлежит, и нормы основ совпадают. Принадлежность — то же правило, что у сборки
 * редакции (resolveDayOwnership + ownsDay, «неизвестно» — своя): подача, которая числит сотрудника, но отдала его дни
 * другому отделу, месяц не закрывает (Стеняев, октябрь 2026: закрытая «ЛИНИЯ» при назначении в ещё открытую
 * «ЛИНИЯ-Общестрой» давала 0 дней вместо живого табеля). Иначе — not_closed: суммы нет, дни закрытой половины с живым
 * табелем не смешиваются. Подачу открыли — она выпадает из выборки, месяц снова не закрыт.
 *
 * Дни подач бригады собраны ещё и по бригадам: их оплачивает доля «Выработки» по КТУ (brigade-salary), а не оклад.
 */
import { query } from '../../config/postgres.js';
import {
  enumerateDatesInclusive,
  ownershipKey,
  ownsDay,
  resolveDayOwnership,
  type IOwnershipRequest,
} from '../timesheet-day-ownership.service.js';
import {
  emptyAbsenceDays,
  PAYROLL_ABSENCE_STATUSES,
  type PayrollAbsenceDates,
  type PayrollAbsenceDays,
  type PayrollBasisQuality,
} from './payroll-basis.service.js';

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
  /** Даты отсутствий; null — основа до миграции 339. */
  absenceDates: Partial<PayrollAbsenceDates> | null;
  overtimeMinutes: Record<string, number>;
  /** Минуты к оплате при почасовой ставке; null — основа до миграции 344. */
  paidMinutes: Record<string, number> | null;
  quality: PayrollBasisQuality;
  /** Отдел подачи; у персональной — null. */
  departmentId: string | null;
  isBrigade: boolean;
  /** Даты периода подачи, которые принадлежат другой подаче; нет — все свои. */
  notOwnedDates?: readonly string[];
}

/** Дни сотрудника в подачах одной бригады за месяц. */
export interface IMonthBrigadeDays {
  departmentId: string;
  workdayDates: string[];
  dayoffDates: string[];
}

export type MonthBasisNotClosedReason = 'not_covered' | 'norm_conflict';

/** Основа месяца для расчёта: из закрытых подач (IClosedMonthBasis) или из живого табеля (предварительный расчёт). */
export interface ICalcMonthBasis {
  normDays: number | null;
  normMinutes: number | null;
  workdayDates: string[];
  dayoffDates: string[];
  absenceDays: PayrollAbsenceDays;
  /** Даты отсутствий любого вида (отпуск, учебный, без содержания, больничный); в расчёте сумм не участвуют. */
  absenceDates: string[];
  /** Переработка в будни по корректировкам: дата → минуты. */
  overtimeMinutes: Record<string, number>;
  /** Минуты к оплате при почасовой ставке: дата → минуты; null — основа до миграции 344 или подачи разошлись. */
  paidMinutes: Record<string, number> | null;
  /** Дни в бригадах — по бригадам: у закрытой основы — дни подач бригад, у живой — дни в окнах членства. */
  brigades: IMonthBrigadeDays[];
}

export interface IClosedMonthBasis extends ICalcMonthBasis {
  state: 'closed';
  /** reconstructed — хоть одна основа дозаполнена по нынешним графикам. */
  quality: PayrollBasisQuality;
  basisIds: number[];
  versionIds: number[];
}

export type MonthBasis = IClosedMonthBasis | { state: 'not_closed'; reason: MonthBasisNotClosedReason };

const nextIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/** Каждая дата [from, to] лежит в периоде подачи, которой эта дата принадлежит. */
export const coversPeriod = (
  sources: ReadonlyArray<{ coverFrom: string; coverTo: string; notOwnedDates?: readonly string[] }>,
  period: { from: string; to: string },
): boolean => {
  const owning = sources.map(source => ({ ...source, notOwned: new Set(source.notOwnedDates ?? []) }));
  for (let date = period.from; date <= period.to; date = nextIsoDay(date)) {
    const covered = owning.some(source => source.coverFrom <= date && date <= source.coverTo && !source.notOwned.has(date));
    if (!covered) return false;
  }
  return true;
};

/**
 * Минуты к оплате из подач — по дате, а не суммой: день принадлежит одной подаче, но одна дата в двух подачах не должна
 * оплатиться дважды. Основа без минут или разные значения одной даты — null: у почасового это ⚠, окладнику закрытый
 * месяц не ломает.
 */
const mergePaidMinutes = (
  sources: readonly IMonthBasisSource[],
  inPeriod: (date: string) => boolean,
): Record<string, number> | null => {
  const merged: Record<string, number> = {};
  for (const source of sources) {
    if (source.paidMinutes === null) return null;
    for (const [date, minutes] of Object.entries(source.paidMinutes)) {
      if (!inPeriod(date)) continue;
      const value = Number(minutes);
      if (merged[date] !== undefined && merged[date] !== value) return null;
      merged[date] = value;
    }
  }
  return merged;
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
  const absenceDates = new Set<string>();
  const overtimeMinutes: Record<string, number> = {};
  for (const source of sources) {
    for (const status of PAYROLL_ABSENCE_STATUSES) {
      absenceDays[status] += Number(source.absenceDays[status] ?? 0);
      for (const date of source.absenceDates?.[status] ?? []) if (inPeriod(date)) absenceDates.add(date);
    }
    for (const [date, minutes] of Object.entries(source.overtimeMinutes)) {
      if (inPeriod(date)) overtimeMinutes[date] = Number(minutes);
    }
  }
  // Дата в двух подачах — один день; рабочий в одной и выход в другой — рабочий.
  const workdayDates = new Set(sources.flatMap(source => source.workdayDates).filter(inPeriod));
  const dayoffDates = new Set(sources.flatMap(source => source.dayoffDates).filter(date => inPeriod(date) && !workdayDates.has(date)));
  return {
    state: 'closed',
    quality: sources.some(source => source.quality === 'reconstructed') ? 'reconstructed' : 'materialized',
    basisIds: sources.map(source => source.basisId).sort((a, b) => a - b),
    versionIds: [...new Set(sources.map(source => source.versionId))].sort((a, b) => a - b),
    normDays: norms.size === 1 ? [...norms][0] : null,
    normMinutes: normMinutes.size === 1 ? [...normMinutes][0] : null,
    workdayDates: [...workdayDates].sort(),
    dayoffDates: [...dayoffDates].sort(),
    absenceDays,
    absenceDates: [...absenceDates].sort(),
    overtimeMinutes,
    paidMinutes: mergePaidMinutes(sources, inPeriod),
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
  approval_id: string;
  manager_employee_id: number | null;
  employee_id: number;
  cover_from: string;
  cover_to: string;
  norm_days: number | null;
  norm_minutes: number | null;
  overtime_minutes: Record<string, number> | null;
  paid_minutes: Record<string, number> | null;
  workday_dates: string[] | null;
  dayoff_dates: string[] | null;
  absence_days: Partial<PayrollAbsenceDays> | null;
  absence_dates: Partial<PayrollAbsenceDates> | null;
  quality: PayrollBasisQuality;
  department_id: string | null;
  is_brigade: boolean;
}

/** Запросы владения днём: по одному на подачу — её сотрудники и даты её периода в месяце. */
const ownershipRequests = (rows: readonly IBasisSourceRow[]): IOwnershipRequest[] => {
  const requests = new Map<number, IOwnershipRequest & { employeeIds: number[] }>();
  for (const row of rows) {
    const approvalId = Number(row.approval_id);
    const request = requests.get(approvalId);
    if (request) {
      request.employeeIds.push(Number(row.employee_id));
    } else {
      requests.set(approvalId, {
        approvalId,
        departmentId: row.department_id ?? null,
        managerEmployeeId: row.manager_employee_id === null ? null : Number(row.manager_employee_id),
        employeeIds: [Number(row.employee_id)],
        dates: enumerateDatesInclusive(row.cover_from, row.cover_to),
      });
    }
  }
  return [...requests.values()];
};

/** Основы закрытых подач месяца YYYY-MM по сотрудникам. */
export const loadMonthBasisSources = async (
  employeeIds: readonly number[],
  month: string,
): Promise<Map<number, IMonthBasisSource[]>> => {
  const result = new Map<number, IMonthBasisSource[]>();
  if (employeeIds.length === 0) return result;
  const rows = await query<IBasisSourceRow>(
    `SELECT b.id::text AS basis_id, v.id::text AS version_id, a.id::text AS approval_id, a.manager_employee_id,
            b.employee_id,
            to_char(GREATEST(a.start_date, $2::date), 'YYYY-MM-DD') AS cover_from,
            to_char(LEAST(a.end_date, ($2::date + INTERVAL '1 month - 1 day')::date), 'YYYY-MM-DD') AS cover_to,
            b.norm_days,
            b.norm_minutes,
            b.overtime_minutes,
            b.paid_minutes,
            b.workday_dates::text[] AS workday_dates,
            b.dayoff_dates::text[] AS dayoff_dates,
            b.absence_days,
            b.absence_dates,
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
  const ownership = await resolveDayOwnership(ownershipRequests(rows ?? []), undefined);
  for (const row of rows ?? []) {
    const employeeId = Number(row.employee_id);
    const approvalId = Number(row.approval_id);
    const source: IMonthBasisSource = {
      basisId: Number(row.basis_id),
      versionId: Number(row.version_id),
      coverFrom: row.cover_from,
      coverTo: row.cover_to,
      normDays: row.norm_days === null ? null : Number(row.norm_days),
      normMinutes: row.norm_minutes === null || row.norm_minutes === undefined ? null : Number(row.norm_minutes),
      overtimeMinutes: row.overtime_minutes ?? {},
      paidMinutes: row.paid_minutes ?? null,
      workdayDates: row.workday_dates ?? [],
      dayoffDates: row.dayoff_dates ?? [],
      absenceDays: row.absence_days ?? {},
      absenceDates: row.absence_dates ?? null,
      quality: row.quality,
      departmentId: row.department_id ?? null,
      isBrigade: row.is_brigade === true,
      notOwnedDates: enumerateDatesInclusive(row.cover_from, row.cover_to)
        .filter(date => !ownsDay(ownership.get(ownershipKey(approvalId, employeeId, date)))),
    };
    const list = result.get(employeeId);
    if (list) list.push(source);
    else result.set(employeeId, [source]);
  }
  return result;
};
