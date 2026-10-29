/**
 * Предварительный расчёт (решения пользователя 28–29.10.2026): табель месяца не закрыт — ФОТ по живому табелю, на
 * экране без пометки «табель не закрыт». «Расчёты», карточка и листок, отделы во вкладке «Табель → Зарплата»
 * (getPreliminaryPayoutForEmployees); бригады вкладки считают по-прежнему. В БД ничего не пишется.
 *
 * Отдел — основа из живого табеля за весь месяц по asOf (текущий месяц — по вчера МСК), с закрытой половиной не
 * склеивается: те же правила дней, нормы и переработки, что при закрытии (buildBasisDraftsForDays).
 *
 * Бригада — дни в окнах членства (как считает доля: loadLiveDays) оплачивает доля «Выработки», не оклад. Открытая
 * бригада без выработки — часы не считаются, участникам технические доли без суммы: расчёт помечается
 * brigade_output; с выработкой — живой расчёт доли (сохранённый stale не берётся). Сотрудника, у которого весь
 * период по asOf в бригаде, общий живой табель не грузит: дни нужны только расчёту доли.
 */
import { getPool, query } from '../../config/postgres.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from '../../controllers/timesheet-assigned-export.controller.js';
import {
  buildMembershipWindowMap,
  isWithinMembershipWindow,
  listEmployeeMembershipsForDepartmentPeriod,
  type IDepartmentEmployeeMembership,
  type IMembershipWindow,
} from '../timesheet-department-assignments.service.js';
import { fetchTimesheetDataForEmployees, type IExportDayValue } from '../timesheet-export.service.js';
import { DEFAULT_KTU_TENTHS, loadBrigadeSalaryInputs } from './brigade-salary-inputs.service.js';
import { computeBrigadePreliminaryShares, type IBrigadeShares } from './brigade-salary.service.js';
import { buildBasisDraftsForDays, emptyAbsenceDays, type IBasisDayValue } from './payroll-basis.service.js';
import type { ICalcMonthBasis, IMonthBrigadeDays } from './payroll-month-basis.service.js';

/** Бригада месяца для предварительного расчёта: состав и окна членства за [1-е, asOf], загруженные один раз. */
export interface IBrigadeContext {
  departmentId: string;
  /** Участники делёжа — без начальников участка. */
  memberIds: number[];
  /** Членство за [1-е, asOf] целиком — вход живого расчёта доли. */
  memberships: IDepartmentEmployeeMembership[];
  /** Окна участников: какие дни сотрудника — дни бригады. */
  windows: Map<number, IMembershipWindow>;
}

/**
 * Бригады, где сотрудники могли состоять в [monthStart, asOf], — те же три источника, что у членства отдела
 * (listEmployeeMembershipsForDepartmentPeriod): назначения, текущий отдел (у большинства только он) и отдел
 * увольнения. Список с запасом — состав подтверждает контекст бригады.
 */
export const loadBrigadeCandidates = async (
  employeeIds: readonly number[],
  monthStart: string,
  asOf: string,
): Promise<string[]> => {
  if (employeeIds.length === 0) return [];
  const rows = await query<{ department_id: string }>(
    `SELECT DISTINCT s.department_id::text AS department_id
       FROM (
         SELECT a.org_department_id AS department_id
           FROM employee_assignments a
          WHERE a.employee_id = ANY($1::int[])
            AND a.effective_from <= $3::date
            AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
         UNION ALL
         SELECT e.org_department_id FROM employees e WHERE e.id = ANY($1::int[])
         UNION ALL
         SELECT de.from_department_id
           FROM employee_dismissal_events de
          WHERE de.employee_id = ANY($1::int[])
            AND de.dismissal_date IS NOT NULL
            AND de.dismissal_date >= $2::date
            AND de.cancelled = false
       ) s
       JOIN org_departments d ON d.id = s.department_id AND d.kind = 'brigade'
      ORDER BY 1`,
    [[...employeeIds], monthStart, asOf],
  );
  return (rows ?? []).map(row => row.department_id);
};

/** Состав бригады за [monthStart, asOf] — как у сетки табеля (уволенный виден в месяце увольнения), без начальников. */
export const loadBrigadeContext = async (
  departmentId: string,
  monthStart: string,
  asOf: string,
): Promise<IBrigadeContext> => {
  // По очереди: контекст грузится внутри слота бригады, одно соединение на слот.
  const memberships = await listEmployeeMembershipsForDepartmentPeriod(
    departmentId, monthStart, asOf, undefined, { firedInDismissalMonth: true },
  );
  const supervisors = await listBrigadeSupervisorEmployeeIdsForDepartments([departmentId]);
  const members = memberships.filter(row => !supervisors.has(Number(row.employee_id)));
  return {
    departmentId,
    memberIds: members.map(row => Number(row.employee_id)).sort((a, b) => a - b),
    memberships,
    windows: buildMembershipWindowMap(members),
  };
};

/**
 * Доли открытой бригады: выработка не внесена ни на одном объекте — технические доли без суммы (часы не считаются,
 * КТУ — введённый или 1,0); есть — живой расчёт по табелю на asOf.
 */
export const resolveOpenBrigadeShares = async (
  context: IBrigadeContext,
  month: string,
  asOf: string,
): Promise<IBrigadeShares> => {
  const inputs = await loadBrigadeSalaryInputs(context.departmentId, `${month}-01`);
  if (inputs.outputs.size === 0) {
    return {
      state: 'open',
      distribution: 'no_output',
      output_amount: null,
      rows: context.memberIds.map(employeeId => ({
        employee_id: employeeId,
        ktu: ((inputs.ktu.get(employeeId) ?? DEFAULT_KTU_TENTHS) / 10).toFixed(1),
        counted_minutes: 0,
        amount: null,
        source: 'live' as const,
        objects: [],
      })),
      objects: [],
    };
  }
  return computeBrigadePreliminaryShares(context.departmentId, month, asOf, inputs, context);
};

const nextIsoDay = (iso: string): string => {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
};

const datesBetween = (from: string, to: string): string[] => {
  const dates: string[] = [];
  for (let date = from; date <= to; date = nextIsoDay(date)) dates.push(date);
  return dates;
};

/** День живого табеля → день основы, как в редакции (buildTimesheetPayload). */
const toBasisDays = (dayMap: ReadonlyMap<string, IExportDayValue> | undefined): Record<string, IBasisDayValue> => {
  const days: Record<string, IBasisDayValue> = {};
  for (const [date, value] of dayMap ?? []) {
    days[date] = {
      status: value.status,
      hours: typeof value.hours === 'number' ? value.hours : 0,
      hours_overridden: Boolean(value.hoursOverridden),
    };
  }
  return days;
};

export interface ILiveMonthBases {
  bases: Map<number, ICalcMonthBasis>;
  /** Сколько сотрудников прочитано из живого табеля (без тех, у кого весь период в бригаде). */
  fetched: number;
}

/**
 * Основы месяца из живого табеля по asOf. periods — период сотрудника в месяце (с приёма по отсечку увольнения),
 * начало не позже asOf; contexts — бригады месяца (дни в их окнах — дни бригады).
 */
export const loadLiveMonthBases = async (
  employeeIds: readonly number[],
  periods: ReadonlyMap<number, { from: string; to: string }>,
  month: string,
  asOf: string,
  contexts: readonly IBrigadeContext[],
): Promise<ILiveMonthBases> => {
  const monthStart = `${month}-01`;
  const bases = new Map<number, ICalcMonthBasis>();
  // Бригада дня: участник (не начальник участка) и дата в окне членства — то же правило, что у loadLiveDays.
  const brigadeOf = (employeeId: number, date: string): string | null => contexts.find(context => (
    context.windows.has(employeeId) && isWithinMembershipWindow(context.windows.get(employeeId), date, 'viaTransferOnly')
  ))?.departmentId ?? null;

  const needLive: number[] = [];
  for (const employeeId of employeeIds) {
    const period = periods.get(employeeId)!;
    const dates = datesBetween(period.from, period.to < asOf ? period.to : asOf);
    const brigadeIds = dates.map(date => brigadeOf(employeeId, date));
    if (dates.length > 0 && brigadeIds.every(id => id !== null)) {
      // Весь период в бригаде: дни оплачивает доля, окладной основы нет.
      bases.set(employeeId, {
        normDays: null,
        normMinutes: null,
        workdayDates: [],
        dayoffDates: [],
        absenceDays: emptyAbsenceDays(),
        overtimeMinutes: {},
        brigades: [...new Set(brigadeIds as string[])].map(departmentId => ({
          departmentId, workdayDates: [], dayoffDates: [],
        })),
      });
    } else {
      needLive.push(employeeId);
    }
  }
  if (needLive.length === 0) return { bases, fetched: 0 };

  const data = await fetchTimesheetDataForEmployees(
    month,
    needLive,
    'Зарплата: предварительно',
    { startDate: monthStart, endDate: asOf },
    'actual',
    true,
    // snapshot — сотрудник берётся при любом статусе, как у редакции табеля.
    { rosterMode: 'snapshot' },
  );
  const drafts = await buildBasisDraftsForDays(getPool(), {
    start_date: monthStart,
    end_date: asOf,
    employees: needLive.map(employeeId => ({ employee_id: employeeId, days: toBasisDays(data.dataMap.get(employeeId)) })),
  });
  for (const draft of drafts) {
    const period = periods.get(draft.employeeId)!;
    const inPeriod = (date: string): boolean => date >= period.from && date <= period.to;
    const workdayDates = draft.workdayDates.filter(inPeriod);
    const dayoffDates = draft.dayoffDates.filter(inPeriod);
    const brigades = new Map<string, IMonthBrigadeDays>();
    const addBrigadeDay = (date: string, key: 'workdayDates' | 'dayoffDates'): void => {
      const departmentId = brigadeOf(draft.employeeId, date);
      if (!departmentId) return;
      const entry = brigades.get(departmentId) ?? { departmentId, workdayDates: [], dayoffDates: [] };
      entry[key].push(date);
      brigades.set(departmentId, entry);
    };
    for (const date of workdayDates) addBrigadeDay(date, 'workdayDates');
    for (const date of dayoffDates) addBrigadeDay(date, 'dayoffDates');
    bases.set(draft.employeeId, {
      normDays: draft.normDays,
      normMinutes: draft.normMinutes,
      workdayDates,
      dayoffDates,
      absenceDays: draft.absenceDays,
      overtimeMinutes: Object.fromEntries(Object.entries(draft.overtimeMinutes).filter(([date]) => inPeriod(date))),
      brigades: [...brigades.values()],
    });
  }
  return { bases, fetched: needLive.length };
};
