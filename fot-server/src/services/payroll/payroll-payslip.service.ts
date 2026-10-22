/**
 * Расчётный листок в «Истории выплат» карточки «Зарплаты»: за месяц — период, отработанные дни
 * по табелю ФОТ и условия оплаты. Суммы статей — из «Оплачено» (payroll-paid.service), здесь их нет.
 *
 * Дни — те же, что в колонке «Дни» единого файла 1С (buildEmployeeRowsForOneC): округление часов,
 * УУ/РБ/УД, отсечка увольнения, будущие дни не считаются. Рабочий — день по графику или плановая
 * суббота/воскресенье в квоте графика (как в ЗУП: «5+2» с двумя субботами даёт 24 рабочих в июле 2026);
 * выходной — согласованный выход сверх графика.
 *
 * «По ставкам ФОТ» — суммы за месяц по ставкам «Справочника» (миграция 324), ставка — за месяц листка:
 * - проезд — если категория на конец периода не «Рабочие» и в месяце нет ни одного дня «Без проезда»;
 * - проживание — одна сумма по записи, действующей на конец периода (самая поздняя из задевающих период):
 *   квартира — её сумма, доплата за общежитие — ставка, проживание в общежитии — ничего.
 */
import { queryOne } from '../../config/postgres.js';
import { isWorkingDay } from '../schedule.service.js';
import { buildEmployeeRowsForOneC } from '../timesheet-excel.service.js';
import { fetchTimesheetDataForEmployees, type IDepartmentTimesheetData } from '../timesheet-export.service.js';
import { DORMITORY_ALLOWANCE_RATE_CODE, TRAVEL_RATE_CODE } from './payroll-rates.service.js';
import { resolveEmployeeStaffCategories } from './payroll-staff-category.js';
import { getTermsForPeriod, type PayrollCalcType, type StaffCategory } from './payroll-terms.service.js';

export interface IPayslipWorkedDays {
  /** Отработано в рабочие дни графика (с плановыми выходными). */
  workday: number;
  /** Отработано в выходные сверх графика. */
  dayoff: number;
}

export interface IPayslipTerms {
  effective_from: string;
  /** null — действует дальше месяца. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  /** Оклад ₽/мес или ставка ₽/час — текстом NUMERIC; null — сумма не задана. */
  amount: string | null;
}

export type PayslipRateAllowanceCode = 'travel' | 'housing' | 'dormitory_allowance';

/** Сумма «По ставкам ФОТ» — NUMERIC текстом. */
export interface IPayslipRateAllowance {
  code: PayslipRateAllowanceCode;
  amount: string;
}

/** Проживание, задевающее период листка: квартира, общежитие или доплата за общежитие; start — YYYY-MM-DD. */
export interface IPayslipHousingRecord {
  kind: 'apartment' | 'dormitory' | 'dormitory_allowance';
  start: string;
  /** Сумма квартиры; у остальных — null. */
  amount: string | null;
}

export interface IPayslipRateFacts {
  /** Категория на конец периода. */
  category: StaffCategory;
  travelRate: string | null;
  /** В месяце есть день «Без проезда». */
  travelStopped: boolean;
  dormitoryAllowanceRate: string | null;
  housing: IPayslipHousingRecord[];
}

export interface IPayrollPayslipInfo {
  month: string;
  /** Период листка: месяц, начало — с даты приёма, конец — по дату увольнения; null — сотрудник в месяце не работал. */
  period_from: string | null;
  period_to: string | null;
  /** null — сотрудника нет в табеле месяца. */
  worked_days: IPayslipWorkedDays | null;
  /** Условия оплаты, действовавшие в периоде, по возрастанию даты начала. */
  terms: IPayslipTerms[];
  /** «По ставкам ФОТ» за месяц; в «Всего начислено» (ЗУП) не входят. */
  rate_allowances: IPayslipRateAllowance[];
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const previousIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

const lastDayOfMonth = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(year, mon, 0).getDate())}`;
};

/** Отработанные дни сотрудника из собранного табеля: рабочие по графику и выходные. null — его нет в табеле. */
export const splitWorkedDays = (
  data: IDepartmentTimesheetData,
  employeeId: number,
): IPayslipWorkedDays | null => {
  const row = buildEmployeeRowsForOneC(data).find(candidate => candidate.employeeId === employeeId);
  if (!row) return null;
  const schedules = data.dailySchedulesMap.get(employeeId);
  let workday = 0;
  let dayoff = 0;
  for (const day of row.workedDayNumbers) {
    const date = `${data.year}-${pad2(data.mon)}-${pad2(day)}`;
    const schedule = schedules?.get(date);
    // Без графика выгрузка считает день рабочим (includeExportDayHours) — так же и здесь.
    const scheduled = !schedule
      || isWorkingDay(schedule, new Date(data.year, data.mon - 1, day), data.calendarMonth)
      || data.plannedWeekendDays?.has(`${employeeId}|${date}`) === true;
    if (scheduled) workday++;
    else dayoff++;
  }
  return { workday, dayoff };
};

/** Период листка: месяц, обрезанный датой приёма и отсечкой увольнения табеля (cutoff — первый день без работы). */
export const payslipPeriod = (
  month: string,
  hireDate: string | null,
  cutoff: string | null,
): { from: string; to: string } | null => {
  const monthStart = `${month}-01`;
  const monthEnd = lastDayOfMonth(month);
  const from = hireDate && hireDate > monthStart && hireDate <= monthEnd ? hireDate : monthStart;
  const to = cutoff && cutoff <= monthEnd ? previousIsoDay(cutoff) : monthEnd;
  return from <= to ? { from, to } : null;
};

/** Заданная ставка больше нуля: ноль и «не задано» строки не дают. */
const positive = (amount: string | null): amount is string => amount !== null && Number(amount) > 0;

/** Строки «По ставкам ФОТ» по фактам месяца — правила в шапке файла. */
export const pickPayslipRateAllowances = (facts: IPayslipRateFacts): IPayslipRateAllowance[] => {
  const result: IPayslipRateAllowance[] = [];
  if (facts.category !== 'worker' && !facts.travelStopped && positive(facts.travelRate)) {
    result.push({ code: 'travel', amount: facts.travelRate });
  }
  // Записи одного сотрудника по дням не пересекаются: самая поздняя по началу действует на конец периода.
  const last = facts.housing.reduce<IPayslipHousingRecord | null>(
    (latest, record) => (latest === null || record.start > latest.start ? record : latest),
    null,
  );
  if (last?.kind === 'apartment' && positive(last.amount)) {
    result.push({ code: 'housing', amount: last.amount });
  } else if (last?.kind === 'dormitory_allowance' && positive(facts.dormitoryAllowanceRate)) {
    result.push({ code: 'dormitory_allowance', amount: facts.dormitoryAllowanceRate });
  }
  return result;
};

/** Факты месяца для «По ставкам ФОТ»: ставки за месяц, «Без проезда» в месяце, проживание в периоде. */
const loadRateFacts = async (
  employeeId: number,
  month: string,
  period: { from: string; to: string },
  category: StaffCategory,
): Promise<IPayslipRateFacts> => {
  const row = await queryOne<{
    travel_rate: string | null;
    dormitory_allowance_rate: string | null;
    travel_stopped: boolean;
    housing: IPayslipHousingRecord[];
  }>(
    `SELECT payroll_rate_value($6, $2::date)::text AS travel_rate,
            payroll_rate_value($7, $2::date)::text AS dormitory_allowance_rate,
            EXISTS (
              SELECT 1 FROM payroll_compensation_stops cs
               WHERE cs.employee_id = $1
                 AND cs.date_from <= $3::date
                 AND (cs.date_to IS NULL OR cs.date_to >= $2::date)
            ) AS travel_stopped,
            COALESCE((
              SELECT json_agg(h ORDER BY h.start)
                FROM (
                  SELECT s.kind, to_char(s.check_in, 'YYYY-MM-DD') AS start, s.amount::text AS amount
                    FROM employee_dormitory_stays s
                   WHERE s.employee_id = $1
                     AND s.check_in <= $5::date
                     AND (s.check_out IS NULL OR s.check_out > $4::date)
                  UNION ALL
                  SELECT 'dormitory_allowance', to_char(a.date_from, 'YYYY-MM-DD'), NULL
                    FROM payroll_dormitory_allowances a
                   WHERE a.employee_id = $1
                     AND a.date_from <= $5::date
                     AND (a.date_to IS NULL OR a.date_to >= $4::date)
                ) h
            ), '[]'::json) AS housing`,
    [employeeId, `${month}-01`, lastDayOfMonth(month), period.from, period.to,
      TRAVEL_RATE_CODE, DORMITORY_ALLOWANCE_RATE_CODE],
  );
  return {
    category,
    travelRate: row?.travel_rate ?? null,
    travelStopped: row?.travel_stopped ?? false,
    dormitoryAllowanceRate: row?.dormitory_allowance_rate ?? null,
    housing: row?.housing ?? [],
  };
};

/** Листок сотрудника за месяц YYYY-MM. */
export const getPayslipInfo = async (employeeId: number, month: string): Promise<IPayrollPayslipInfo> => {
  // snapshot — сотрудник берётся при любом статусе: уволенный в месяце увольнения тоже со своими днями
  // (обычный состав 1С его не берёт). Дни после увольнения режет cutoff.
  const [data, employee] = await Promise.all([
    fetchTimesheetDataForEmployees(month, [employeeId], 'Payroll', 'FULL', 'actual', true, { rosterMode: 'snapshot' }),
    queryOne<{ hire_date: string | null }>('SELECT hire_date FROM employees WHERE id = $1', [employeeId]),
  ]);
  const period = payslipPeriod(month, employee?.hire_date ?? null, data.cutoffByEmployeeId?.get(employeeId) ?? null);
  if (!period) return { month, period_from: null, period_to: null, worked_days: null, terms: [], rate_allowances: [] };

  const termsByEmployee = await getTermsForPeriod([employeeId], period.from, period.to);
  const termRows = termsByEmployee.get(employeeId) ?? [];
  // Категория на конец периода: последний отрезок условий; условий нет — по текущему отделу.
  const category = termRows.at(-1)?.staff_category
    ?? (await resolveEmployeeStaffCategories([employeeId])).get(employeeId)
    ?? 'office';
  const terms = termRows.map(row => {
    const amount = row.calc_type === 'hourly' ? row.hourly_rate : row.monthly_salary;
    return {
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      calc_type: row.calc_type,
      // NUMERIC приходит строкой — оставляем текстом, как остальные суммы «Зарплаты».
      amount: amount === null ? null : String(amount),
    };
  });

  return {
    month,
    period_from: period.from,
    period_to: period.to,
    worked_days: splitWorkedDays(data, employeeId),
    terms,
    rate_allowances: pickPayslipRateAllowances(await loadRateFacts(employeeId, month, period, category)),
  };
};
