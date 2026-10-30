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
 * - проживание — по дням (решения пользователя 30.10.2026, миграция 339), окно — период сотрудника в месяце, у живого
 *   табеля — по asOf: квартира — её ставка за день × календарные дни проживания, кроме дней отсутствий (отпуск
 *   любого вида, больничный); общежитие — ничего; доплата за общежитие — ставка «Доплата за общежитие» × дни,
 *   отработанные в бригаде, кроме дней в общежитии и квартире, с месяца включателя payroll_switches (до него — нет).
 *   Счёт в целых копейках: ставка × дни, без округления.
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
  /**
   * Для расшифровки: у проезда — ставка «Справочника» за полный месяц, у проживания — ставка за день (у квартиры
   * со сменой ставки в месяце — нет).
   */
  rate?: string;
  /** Только у проживания: за сколько дней. */
  housing_days?: number;
}

/** Проживание, задевающее период: квартира или общежитие; YYYY-MM-DD, end — день выезда (уже не живёт), null — живёт. */
export interface IPayslipHousingRecord {
  kind: 'apartment' | 'dormitory';
  start: string;
  end: string | null;
  /** Ставка квартиры за день; у общежития — null. */
  amount: string | null;
}

/** Дни, по которым считается проживание. */
export interface IPayslipHousingDays {
  /** Окно счёта: период сотрудника в месяце, у живого табеля — по asOf. */
  from: string;
  to: string;
  /** Дни отсутствий (отпуск любого вида, больничный) — квартира за них не платится. */
  absenceDates: readonly string[];
  /** Дни, отработанные в бригаде, — доплата за общежитие. */
  brigadeDates: readonly string[];
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
  /** С какого месяца (YYYY-MM-01) доплата за общежитие считается сама; null — включатель не стоит. */
  dormitoryAllowanceFrom: string | null;
  housing: IPayslipHousingRecord[];
  housingDays: IPayslipHousingDays;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const shiftIsoDay = (iso: string, days: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const previousIsoDay = (iso: string): string => shiftIsoDay(iso, -1);

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

const toCents = (amount: string): number => Math.round(Number(amount) * 100);

const fromCents = (cents: number): string => (cents / 100).toFixed(2);

/** Проживание дня: запись, в которую день попадает ([въезд, выезд)); записи одного сотрудника не пересекаются. */
const stayOn = (records: readonly IPayslipHousingRecord[], date: string): IPayslipHousingRecord | null => (
  records.find(record => record.start <= date && (record.end === null || date < record.end)) ?? null
);

/** Квартира и доплата за общежитие по дням — правила в шапке файла. */
export const housingAllowances = (
  facts: Pick<IPayslipRateFacts, 'housing' | 'housingDays' | 'dormitoryAllowanceRate' | 'dormitoryAllowanceFrom'>,
): IPayslipRateAllowance[] => {
  const result: IPayslipRateAllowance[] = [];
  const { from, to, absenceDates, brigadeDates } = facts.housingDays;
  if (from > to) return result;

  const absent = new Set(absenceDates);
  // Ставка → дни: у квартиры ставка могла смениться в месяце.
  const apartmentDays = new Map<string, number>();
  for (let date = from; date <= to; date = shiftIsoDay(date, 1)) {
    const stay = stayOn(facts.housing, date);
    if (stay?.kind !== 'apartment' || !positive(stay.amount) || absent.has(date)) continue;
    apartmentDays.set(stay.amount, (apartmentDays.get(stay.amount) ?? 0) + 1);
  }
  if (apartmentDays.size > 0) {
    const rates = [...apartmentDays];
    result.push({
      code: 'housing',
      amount: fromCents(rates.reduce((sum, [rate, days]) => sum + toCents(rate) * days, 0)),
      housing_days: rates.reduce((sum, [, days]) => sum + days, 0),
      ...(rates.length === 1 ? { rate: rates[0][0] } : {}),
    });
  }

  const rate = facts.dormitoryAllowanceRate;
  if (positive(rate) && facts.dormitoryAllowanceFrom !== null && `${from.slice(0, 7)}-01` >= facts.dormitoryAllowanceFrom) {
    const days = new Set(brigadeDates.filter(date => date >= from && date <= to && stayOn(facts.housing, date) === null)).size;
    if (days > 0) {
      result.push({ code: 'dormitory_allowance', amount: fromCents(toCents(rate) * days), rate, housing_days: days });
    }
  }
  return result;
};

/** Строки «По ставкам ФОТ» по фактам месяца — правила в шапке файла. */
export const pickPayslipRateAllowances = (facts: IPayslipRateFacts): IPayslipRateAllowance[] => {
  const result: IPayslipRateAllowance[] = [];
  if (facts.category !== 'worker' && !facts.travelStopped && positive(facts.travelRate) && facts.travelDays) {
    const amount = proratedTravel(facts.travelRate, facts.travelDays);
    // Дни сверх нормы проезд не увеличивают — и в подписи их нет.
    const days = { worked: Math.min(facts.travelDays.worked, facts.travelDays.norm), norm: facts.travelDays.norm };
    if (amount !== null) result.push({ code: 'travel', amount, days, rate: facts.travelRate });
  }
  result.push(...housingAllowances(facts));
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
