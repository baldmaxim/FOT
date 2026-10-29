/**
 * Чистые правила расчётного листка и «К выплате (ФОТ)»: период месяца сотрудника, проезд пропорционально
 * дням и строки «По ставкам ФОТ» (проезд, проживание). Без БД — общие для листка (payroll-payslip.service)
 * и расчёта (payroll-calc.service), чтобы те не импортировали друг друга.
 *
 * - проезд — если категория месяца (по табелю, payroll-staff-category.ts; как в «Своде») не «Рабочие» и в месяце
 *   нет ни одного дня «Без проезда». Ставка — максимум за месяц: как в ЗУП, ставка × отработанные дни / норма
 *   дней графика, до рубля (половина — вверх). Отработанные — рабочие дни плюс плановые и согласованные выходы
 *   в выходные (несогласованные выгрузка обнуляет), не больше нормы. Норма — дни по графику за весь месяц +
 *   плановые субботы/воскресенья (в августе 2026 у «5+2» с двумя субботами — 23);
 * - проживание — одна сумма по записи, действующей на конец периода (самая поздняя из задевающих период):
 *   квартира — её сумма, доплата за общежитие — ставка, проживание в общежитии — ничего.
 */
import type { StaffCategory } from './payroll-terms.service.js';

export interface IPayslipWorkedDays {
  /** Отработано в рабочие дни графика (с плановыми выходными). */
  workday: number;
  /** Отработано в выходные сверх графика. */
  dayoff: number;
}

export type PayslipRateAllowanceCode = 'travel' | 'housing' | 'dormitory_allowance';

/** Дни проезда: отработано (рабочие + выходы в выходные, не больше нормы) из нормы дней графика за месяц. */
export interface IPayslipTravelDays {
  worked: number;
  norm: number;
}

/** Сумма «По ставкам ФОТ» — NUMERIC текстом. */
export interface IPayslipRateAllowance {
  code: PayslipRateAllowanceCode;
  amount: string;
  /** Только у проезда: из скольких дней посчитан. */
  days?: IPayslipTravelDays;
  /** Только у проезда: ставка «Справочника» за полный месяц — для расшифровки. */
  rate?: string;
}

/** Проживание, задевающее период листка: квартира, общежитие или доплата за общежитие; start — YYYY-MM-DD. */
export interface IPayslipHousingRecord {
  kind: 'apartment' | 'dormitory' | 'dormitory_allowance';
  start: string;
  /** Сумма квартиры; у остальных — null. */
  amount: string | null;
}

export interface IPayslipRateFacts {
  /** Категория месяца. */
  category: StaffCategory;
  travelRate: string | null;
  /** В месяце есть день «Без проезда». */
  travelStopped: boolean;
  /** Отработано / норма за месяц; null — сотрудника нет в табеле месяца. */
  travelDays: IPayslipTravelDays | null;
  dormitoryAllowanceRate: string | null;
  housing: IPayslipHousingRecord[];
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const previousIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

export const lastDayOfMonth = (month: string): string => {
  const [year, mon] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(year, mon, 0).getDate())}`;
};

/**
 * Проезд за месяц: ставка × отработано / норма, до рубля, половина — вверх (как ЗУП: 2 730 × 18/23 = 2 136,52 → 2 137).
 * Счёт в целых копейках. Отработал норму — ставка как есть, с копейками. null — дней или нормы нет.
 */
export const proratedTravel = (rate: string, days: IPayslipTravelDays): string | null => {
  if (days.norm <= 0 || days.worked <= 0) return null;
  if (days.worked >= days.norm) return rate;
  const rateCents = Math.round(Number(rate) * 100);
  const normCents = days.norm * 100;
  const rubles = Math.floor((2 * rateCents * days.worked + normCents) / (2 * normCents));
  return rubles > 0 ? `${rubles}.00` : null;
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
  if (facts.category !== 'worker' && !facts.travelStopped && positive(facts.travelRate) && facts.travelDays) {
    const amount = proratedTravel(facts.travelRate, facts.travelDays);
    // Дни сверх нормы проезд не увеличивают — и в подписи их нет.
    const days = { worked: Math.min(facts.travelDays.worked, facts.travelDays.norm), norm: facts.travelDays.norm };
    if (amount !== null) result.push({ code: 'travel', amount, days, rate: facts.travelRate });
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

/** График месяца в листке: имя и дни, когда он действовал (YYYY-MM-DD, по — включительно). */
export interface IPayslipSchedule {
  name: string;
  from: string;
  to: string;
}

/** Без имени в справочнике — так и пишем. */
export const UNNAMED_SCHEDULE = 'Стандартный график';

/**
 * Графики по дням → интервалы: соседние дни с одним графиком и одной точкой отсчёта цикла — один интервал (новая
 * точка отсчёта — новый интервал, даже при том же имени). days — по возрастанию даты, без пропусков.
 */
export const groupPayslipSchedules = (
  days: ReadonlyArray<readonly [string, { schedule_id: string; name?: string | null; assignment_anchor_date?: string | null }]>,
): IPayslipSchedule[] => {
  const result: Array<IPayslipSchedule & { key: string }> = [];
  for (const [date, schedule] of days) {
    const key = `${schedule.schedule_id}|${schedule.assignment_anchor_date ?? ''}`;
    const last = result[result.length - 1];
    if (last && last.key === key) {
      last.to = date;
    } else {
      result.push({ key, name: schedule.name?.trim() || UNNAMED_SCHEDULE, from: date, to: date });
    }
  }
  return result.map(({ name, from, to }) => ({ name, from, to }));
};
