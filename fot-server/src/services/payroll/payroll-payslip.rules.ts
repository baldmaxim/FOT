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
 * - проживание — по дням (миграция 339), окно — период сотрудника в месяце, у живого табеля — по asOf:
 *   квартира (решения пользователя 03.11.2026; 1С за сентябрь 2026 совпала у 68 из 80) — ставка за день × (отработанные
 *   дни за время проживания + выходные месяца), всего не больше дней месяца. Отработанные — те же дни, что для оклада и
 *   проезда: явка, согласованные выходы, УУ, РБ, УД; Н, отпуск, больничный и выход без корректировки — нет. Выходные —
 *   числом, без дат: дни месяца − норма дней графика (сентябрь 2026: 30 − 24 = 6), и при заселении или выезде внутри
 *   месяца целиком. За месяц отработано меньше недели (меньше 7 дней) — только отработанные; за время проживания ни
 *   одного — строки нет;
 *   общежитие — ничего; доплата за общежитие (решения 30.10.2026) — ставка «Доплата за общежитие» × дни, отработанные
 *   в бригаде, кроме дней в общежитии и квартире, с месяца включателя payroll_switches (до него — нет).
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
  /** Отработанные дни месяца, могут повторяться — квартира. */
  workedDates: readonly string[];
  /** Норма дней графика за весь месяц — выходные квартиры; null или 0 — неизвестна, выходных нет. */
  normDays: number | null;
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

/** С какого числа отработанных за месяц дней к квартире прибавляются выходные: меньше недели — только отработанные. */
const HOUSING_WEEKENDS_MIN_WORKED_DAYS = 7;

/**
 * Выходные между ставками квартиры: пропорционально дням проживания при ставке, остаток — большей дробной части,
 * при равенстве — более поздней ставке. Счёт в целых. stayDays — ставки в порядке дат.
 */
const splitHousingWeekends = (stayDays: ReadonlyMap<string, number>, weekends: number): Map<string, number> => {
  const total = [...stayDays.values()].reduce((sum, days) => sum + days, 0);
  const shares = [...stayDays].map(([rate, days], order) => ({
    rate,
    order,
    whole: Math.floor((weekends * days) / total),
    rest: (weekends * days) % total,
  }));
  const remainder = weekends - shares.reduce((sum, share) => sum + share.whole, 0);
  const extra = new Set(
    [...shares].sort((a, b) => b.rest - a.rest || b.order - a.order).slice(0, remainder).map(share => share.rate),
  );
  return new Map(shares.map(share => [share.rate, share.whole + (extra.has(share.rate) ? 1 : 0)]));
};

/** Квартира: отработанные дни за время проживания + выходные месяца — правила в шапке файла. */
const apartmentAllowance = (
  facts: Pick<IPayslipRateFacts, 'housing' | 'housingDays'>,
): IPayslipRateAllowance | null => {
  const { from, to, workedDates, normDays } = facts.housingDays;
  const worked = new Set(workedDates.filter(date => date >= from && date <= to));
  // Ставка → дни проживания и оплачиваемые из них: у квартиры ставка могла смениться в месяце.
  const stayDays = new Map<string, number>();
  const paidDays = new Map<string, number>();
  for (let date = from; date <= to; date = shiftIsoDay(date, 1)) {
    const stay = stayOn(facts.housing, date);
    if (stay?.kind !== 'apartment' || !positive(stay.amount)) continue;
    stayDays.set(stay.amount, (stayDays.get(stay.amount) ?? 0) + 1);
    if (worked.has(date)) paidDays.set(stay.amount, (paidDays.get(stay.amount) ?? 0) + 1);
  }
  const workedInStay = [...paidDays.values()].reduce((sum, days) => sum + days, 0);
  if (workedInStay === 0) return null;

  const monthDays = Number(lastDayOfMonth(from.slice(0, 7)).slice(8));
  const monthWeekends = normDays !== null && normDays > 0 && worked.size >= HOUSING_WEEKENDS_MIN_WORKED_DAYS
    ? Math.max(0, monthDays - normDays)
    : 0;
  const weekends = Math.min(monthWeekends, monthDays - workedInStay);
  for (const [rate, days] of splitHousingWeekends(stayDays, weekends)) {
    paidDays.set(rate, (paidDays.get(rate) ?? 0) + days);
  }

  const rates = [...paidDays].filter(([, days]) => days > 0);
  return {
    code: 'housing',
    amount: fromCents(rates.reduce((sum, [rate, days]) => sum + toCents(rate) * days, 0)),
    housing_days: rates.reduce((sum, [, days]) => sum + days, 0),
    ...(rates.length === 1 ? { rate: rates[0][0] } : {}),
  };
};

/** Квартира и доплата за общежитие по дням — правила в шапке файла. */
export const housingAllowances = (
  facts: Pick<IPayslipRateFacts, 'housing' | 'housingDays' | 'dormitoryAllowanceRate' | 'dormitoryAllowanceFrom'>,
): IPayslipRateAllowance[] => {
  const result: IPayslipRateAllowance[] = [];
  const { from, to, brigadeDates } = facts.housingDays;
  if (from > to) return result;

  const apartment = apartmentAllowance(facts);
  if (apartment) result.push(apartment);

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
