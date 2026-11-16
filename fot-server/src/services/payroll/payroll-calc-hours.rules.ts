/**
 * Оклад по часам — ветка buildPayrollCalc для месяцев с ноября 2026, где есть окладная строка условий (решения
 * пользователя 16.11.2026, payroll-salary-hours.ts). Чистые правила, без БД:
 * - часы дня — минуты к оплате основы (paidMinutes): целые часы «Единого 1С», без правки не больше смены, правка — её
 *   часы (тоже до целого часа), «УУ», РБ, учебный день без часов — смена по графику;
 * - норма — минуты графика сотрудника за весь месяц (norm_minutes основы с ноября): приём и увольнение её не режут;
 * - минуты окладных дат распределяются по датам (splitMinutesByNorm): рабочий день (и плановая Сб/Вс) — минуты дня
 *   без переработки по правке, они только добирают норму, сверх неё не оплачиваются (правка «8» в пятницу графика
 *   7 ч — не переработка, решение 27.10.2026); выход в выходной добирает норму после рабочих дней, остаток —
 *   «Переработка»; часы правки сверх порога (≥ 8 ч, payroll-basis.service) — «Переработка», норму не добирают;
 *   «Без переработки» снимает остаток выхода и часы правки своих дат, выход по-прежнему добирает норму;
 * - «По трудовому договору» — (оклад + премиальная) × минуты сегмента / норма; весь месяц одним сегментом и минуты =
 *   норме — оклад как есть; ruble — до рубля, daily_kopeck — сумма сегмента до копейки один раз;
 * - почасовые сегменты смешанного месяца — ставка × минуты, как в дневном расчёте; в норму и переработку окладной части
 *   не входят;
 * - «Премиальная» — плановая доплата × min(окладные и почасовые минуты её периода, норма) / норма, до рубля; весь
 *   месяц и минуты = норме — как есть;
 * - «Переработка» — минуты переработки × оклад даты (без премиальной) / норма, до копейки, одинарно;
 * - нет минут хоть у одной даты или нет нормы — сумма «По трудовому договору» неизвестна целиком (null), «Премиальная»
 *   и «Переработка» не считаются: частичная сумма за начисление не выдаётся.
 */
import {
  cents,
  clampPeriod,
  hourlyAmountCents,
  inRange,
  prorateMinutesCents,
  prorateMinutesToRubleCents,
} from './payroll-calc-money.js';
import type {
  ICalcSegment,
  IOvertimeStopPeriod,
  IPayrollCalcLine,
  IPlannedSupplementPeriod,
  PayrollCalcLinePart,
  PayrollCalcMissing,
} from './payroll-calc.rules.js';
import { centsToAmount } from './payroll-summary.attribution.js';

export interface ISalaryHoursInput {
  monthStart: string;
  monthEnd: string;
  /** Норма минут графика за месяц; null — нет. */
  normMinutes: number | null;
  /** Сегменты условий, задевающие месяц. */
  segments: readonly ICalcSegment[];
  /** Дни бригад уже исключены. */
  workdayDates: readonly string[];
  dayoffDates: readonly string[];
  /** Минуты к оплате: дата → минуты; null — их нет совсем. */
  paidMinutes: Readonly<Record<string, number>> | null;
  /** Переработка в будни по правкам: дата → минуты. */
  overtimeMinutes: Readonly<Record<string, number>>;
  overtimeStops: readonly IOvertimeStopPeriod[];
  plannedSupplements: readonly IPlannedSupplementPeriod[];
}

/** Минуты окладных дат: в оклад и в переработку, по датам; одна дата может делиться. */
export interface IMinutesSplit {
  contract: Record<string, number>;
  overtime: Record<string, number>;
}

/**
 * Распределение минут окладных дат — правила в шапке файла. workdays — обычные минуты рабочих дней (без переработки по
 * правке), dayoffs — минуты выходов, weekdayOvertime — часы правки сверх порога; stopped — дата в «Без переработки».
 */
export const splitMinutesByNorm = (input: {
  workdays: Readonly<Record<string, number>>;
  dayoffs: Readonly<Record<string, number>>;
  weekdayOvertime: Readonly<Record<string, number>>;
  norm: number;
  stopped: (date: string) => boolean;
}): IMinutesSplit => {
  const contract: Record<string, number> = {};
  const overtime: Record<string, number> = {};
  let left = input.norm;
  const fill = (date: string, minutes: number): number => {
    const take = Math.max(0, Math.min(minutes, left));
    if (take > 0) contract[date] = (contract[date] ?? 0) + take;
    left -= take;
    return minutes - take;
  };
  for (const [date, minutes] of Object.entries(input.workdays).sort(([a], [b]) => a.localeCompare(b))) {
    // Сверх нормы обычные минуты рабочего дня не оплачиваются.
    fill(date, minutes);
  }
  for (const [date, minutes] of Object.entries(input.dayoffs).sort(([a], [b]) => a.localeCompare(b))) {
    const rest = fill(date, minutes);
    if (rest > 0 && !input.stopped(date)) overtime[date] = (overtime[date] ?? 0) + rest;
  }
  for (const [date, minutes] of Object.entries(input.weekdayOvertime)) {
    if (minutes > 0 && !input.stopped(date)) overtime[date] = (overtime[date] ?? 0) + minutes;
  }
  return { contract, overtime };
};

const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 100) / 100;

const sumMinutes = (byDate: Readonly<Record<string, number>>, from: string, to: string | null): number => (
  Object.entries(byDate).reduce((sum, [date, minutes]) => sum + (inRange(date, from, to) ? minutes : 0), 0)
);

/** Строки «По трудовому договору», «Премиальная», «Переработка» месяца с окладом по часам — правила в шапке файла. */
export const buildSalaryHoursLines = (
  input: ISalaryHoursInput,
): { lines: IPayrollCalcLine[]; missing: PayrollCalcMissing[] } => {
  const missing = new Set<PayrollCalcMissing>();
  const lines: IPayrollCalcLine[] = [];
  const norm = input.normMinutes !== null && input.normMinutes > 0 ? input.normMinutes : null;
  const segmentOf = (date: string): ICalcSegment | null => (
    input.segments.find(segment => inRange(date, segment.from, segment.to)) ?? null
  );
  const stopped = (date: string): boolean => input.overtimeStops.some(stop => inRange(date, stop.date_from, stop.date_to));
  const isHourlyDate = (date: string): boolean => segmentOf(date)?.calcType === 'hourly';
  const dayoffSet = new Set(input.dayoffDates);
  const allDates = [...input.workdayDates, ...input.dayoffDates].sort();
  const salaryDates = allDates.filter(date => !isHourlyDate(date));
  const hourlyDates = allDates.filter(isHourlyDate);
  const paidOf = (date: string): number | null => input.paidMinutes?.[date] ?? null;

  // Почасовые даты — как в дневном расчёте: выход в «Без переработки» не оплачивается, часы правки дня снимаются.
  const hourlyMinutesOf = (date: string): number | null => {
    const isStopped = stopped(date);
    if (isStopped && dayoffSet.has(date)) return 0;
    const minutes = paidOf(date);
    if (minutes === null) return null;
    return isStopped ? Math.max(0, minutes - (input.overtimeMinutes[date] ?? 0)) : minutes;
  };

  if (norm === null && salaryDates.length > 0) missing.add('no_norm');
  const salaryUnknown = salaryDates.some(date => paidOf(date) === null);
  const hourlyMinutesByDate: Record<string, number> = {};
  let hourlyUnknown = false;
  for (const date of hourlyDates) {
    const minutes = hourlyMinutesOf(date);
    if (minutes === null) hourlyUnknown = true;
    else hourlyMinutesByDate[date] = minutes;
  }
  if (salaryUnknown || hourlyUnknown) missing.add('hourly');

  const split: IMinutesSplit = norm === null || salaryUnknown
    ? { contract: {}, overtime: {} }
    : splitMinutesByNorm({
      workdays: Object.fromEntries(salaryDates.filter(date => !dayoffSet.has(date)).map(date => [
        date, Math.max(0, (paidOf(date) ?? 0) - (input.overtimeMinutes[date] ?? 0)),
      ])),
      dayoffs: Object.fromEntries(salaryDates.filter(date => dayoffSet.has(date)).map(date => [date, paidOf(date) ?? 0])),
      weekdayOvertime: Object.fromEntries(Object.entries(input.overtimeMinutes)
        .filter(([date]) => !isHourlyDate(date) && !dayoffSet.has(date))),
      norm,
      stopped,
    });
  // Норма нужна только окладным датам: без них почасовая часть смешанного месяца известна и так.
  const known = !salaryUnknown && !hourlyUnknown && (norm !== null || salaryDates.length === 0);

  // «По трудовому договору»: окладные сегменты по минутам, почасовые — ставкой.
  const wholeMonthSegment = input.segments.length === 1
    && input.segments[0].from <= input.monthStart
    && (input.segments[0].to === null || input.segments[0].to >= input.monthEnd);
  const parts: PayrollCalcLinePart[] = [];
  let contractCents = 0;
  let salaryMinutes = 0;
  let hourlyMinutes = 0;
  for (const segment of input.segments) {
    const period = clampPeriod(segment.from, segment.to, input.monthStart, input.monthEnd);
    if (segment.calcType === 'hourly') {
      const dates = hourlyDates.filter(date => inRange(date, segment.from, segment.to));
      if (dates.length === 0 || dates.some(date => hourlyMinutesByDate[date] === undefined)) continue;
      const minutes = dates.reduce((sum, date) => sum + hourlyMinutesByDate[date], 0);
      const partCents = hourlyAmountCents(segment.hourlyRateUnits, minutes);
      contractCents += partCents;
      hourlyMinutes += minutes;
      parts.push({
        kind: 'hourly', ...period, rate: (segment.hourlyRateUnits / 10_000).toFixed(4), minutes, amount: centsToAmount(partCents),
      });
      continue;
    }
    if (norm === null) continue;
    const minutes = sumMinutes(split.contract, segment.from, segment.to);
    if (minutes === 0) continue;
    const base = segment.salaryCents + segment.bonusCents;
    const rounding = wholeMonthSegment && minutes === norm
      ? 'whole'
      : segment.rounding === 'daily_kopeck' ? 'kopeck' : 'ruble';
    const partCents = rounding === 'whole' ? base
      : rounding === 'kopeck' ? prorateMinutesCents(base, minutes, norm)
        : prorateMinutesToRubleCents(base, minutes, norm);
    contractCents += partCents;
    salaryMinutes += minutes;
    parts.push({
      kind: 'salary_hours',
      ...period,
      salary: centsToAmount(segment.salaryCents),
      bonus: centsToAmount(segment.bonusCents),
      minutes,
      norm_minutes: norm,
      rounding,
      amount: centsToAmount(partCents),
    });
  }
  const outsideTerms = (byDate: Readonly<Record<string, number>>): boolean => (
    Object.entries(byDate).some(([date, minutes]) => minutes > 0 && segmentOf(date) === null)
  );
  if (outsideTerms(split.contract) || outsideTerms(split.overtime)) missing.add('no_terms');
  if (salaryDates.length > 0 || hourlyDates.length > 0) {
    lines.push({
      code: 'contract',
      amount: known ? centsToAmount(contractCents) : null,
      ...(salaryMinutes + hourlyMinutes > 0 ? { hours: hoursOf(salaryMinutes + hourlyMinutes) } : {}),
      parts,
    });
  }
  if (!known) return { lines, missing: [...missing] };
  if (norm === null) {
    // Плановой доплате нечем делить: дат периода нет — и доплаты нет, иначе итог неизвестен.
    const plannedDates = input.plannedSupplements.some(period => (
      allDates.some(date => inRange(date, period.date_from, period.date_to))
    ));
    if (plannedDates) missing.add('no_norm');
    return { lines, missing: [...missing] };
  }

  // «Премиальная»: минуты оклада и почасовые минуты периода доплаты, не больше нормы.
  let bonusCents = 0;
  const bonusParts: PayrollCalcLinePart[] = [];
  for (const period of input.plannedSupplements) {
    const minutes = Math.min(
      sumMinutes(split.contract, period.date_from, period.date_to)
        + sumMinutes(hourlyMinutesByDate, period.date_from, period.date_to),
      norm,
    );
    if (minutes === 0) continue;
    const wholeMonth = period.date_from <= input.monthStart && (period.date_to === null || period.date_to >= input.monthEnd);
    const partCents = wholeMonth && minutes === norm
      ? cents(period.amount)
      : prorateMinutesToRubleCents(cents(period.amount), minutes, norm);
    bonusCents += partCents;
    bonusParts.push({
      kind: 'planned_supplement_hours',
      ...clampPeriod(period.date_from, period.date_to, input.monthStart, input.monthEnd),
      base: centsToAmount(cents(period.amount)),
      minutes,
      norm_minutes: norm,
      amount: centsToAmount(partCents),
    });
  }
  if (bonusCents > 0) {
    const bonusHours = hoursOf(Math.min(salaryMinutes + hourlyMinutes, norm));
    lines.push({ code: 'bonus', amount: centsToAmount(bonusCents), hours: bonusHours, parts: bonusParts });
  }

  // «Переработка»: по окладу сегмента своей даты.
  const minutesBySegment = new Map<ICalcSegment, number>();
  for (const [date, minutes] of Object.entries(split.overtime)) {
    const segment = segmentOf(date);
    if (segment) minutesBySegment.set(segment, (minutesBySegment.get(segment) ?? 0) + minutes);
  }
  if (minutesBySegment.size > 0) {
    let overtimeCents = 0;
    let overtimeMinutes = 0;
    const overtimeParts: PayrollCalcLinePart[] = [];
    for (const [segment, minutes] of [...minutesBySegment].sort(([a], [b]) => a.from.localeCompare(b.from))) {
      const partCents = prorateMinutesCents(segment.salaryCents, minutes, norm);
      overtimeCents += partCents;
      overtimeMinutes += minutes;
      overtimeParts.push({
        kind: 'overtime_hours',
        ...clampPeriod(segment.from, segment.to, input.monthStart, input.monthEnd),
        salary: centsToAmount(segment.salaryCents),
        minutes,
        norm_minutes: norm,
        amount: centsToAmount(partCents),
      });
    }
    lines.push({ code: 'overtime', amount: centsToAmount(overtimeCents), hours: hoursOf(overtimeMinutes), parts: overtimeParts });
  }
  return { lines, missing: [...missing] };
};
