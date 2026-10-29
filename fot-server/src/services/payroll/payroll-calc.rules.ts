/**
 * «К выплате (ФОТ)» за месяц — чистые правила (без БД). Правила сверены с ЗУП за август 2026:
 * - дни оклада — рабочие дни и выходы в выходные, не больше нормы: выходы сначала добирают норму, сверх неё —
 *   «Переработка». Как ЗУП: 20 рабочих + 2 выхода при норме 21 — оклад 21/21 и один выход; 24 рабочих при норме
 *   23 — оклад 23/23 и один выход (август 2026: так совпало 359 окладов из 412, без добора — 326);
 * - «По трудовому договору» (contract) — (оклад + премиальная часть) × дни оклада сегмента условий / норма дней
 *   месяца. Округление — признак условий proration_rounding: ruble — до рубля, половина вверх
 *   (130 952,38 → 130 952); daily_kopeck — дневная ставка до копейки × дни (250 000 / 21 = 11 904,76 × 11 =
 *   130 952,36). Полный месяц одним сегментом — оклад как есть;
 * - «Премиальная» (bonus) — плановая доплата × дни оклада в её периоде / норма, до рубля (20 000 × 19/22 = 17 273);
 * - «Разовая доплата» (supplement) — разовые доплаты месяца целиком;
 * - «Переработка» (overtime) — оклад сегмента даты выхода / норма × число выходов сверх нормы, одинарно, до рубля;
 *   плюс переработка в будни по корректировкам — оклад сегмента даты / норма часов месяца × часы, одинарно, до копейки
 *   (Абраменко, август: 250 000 / 168 × 6 = 8 928,57, как ЗУП). «Без переработки» (миграция 335) снимает выходы
 *   и часы дат своего периода; выходы, добирающие норму, остаются в окладе;
 * - «Проезд» и «Компенсация проживания» — строки «По ставкам ФОТ» (payroll-payslip.rules.ts);
 * - «Выработка бригады» (brigade) — доля «Выработки» бригады по КТУ из зафиксированного расчёта бригады
 *   (brigade-salary.service); дни подач бригады в оклад не идут. Выработка не введена или расчёт с ошибкой —
 *   доли нет, итог помечен неполным;
 * - «Удержано» — удержания «Справочника» за месяц по видам.
 * Итог «К выплате (ФОТ)» = начислено − удержано, без НДФЛ — как «Выплачено» из 1С. Отпускные, больничные и
 * учебный отпуск ФОТ не считает: дни есть — итог помечается неполным (missing).
 *
 * Сегменты: соседние строки условий с одинаковыми видом оплаты, окладом, премией и округлением склеиваются —
 * смена одной компенсации даёт новую строку условий, но не новую границу округления.
 * Деньги — целые копейки (Math.round(x * 100), как во всей «Зарплате»), наружу — строки с двумя знаками.
 */
import type { PayrollAbsenceDays } from './payroll-basis.service.js';
import type { IPayslipRateAllowance } from './payroll-payslip.rules.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';
import type { ProrationRounding } from './payroll-terms.service.js';

export type PayrollCalcLineCode = 'contract' | 'brigade' | 'bonus' | 'supplement' | 'overtime' | 'travel' | 'housing';

export type PayrollCalcMissing =
  | 'no_norm' | 'no_terms' | 'hourly' | 'vacation_pay' | 'sick_pay' | 'educational_pay'
  | 'brigade_output' | 'brigade_error';

export interface IPayrollCalcLine {
  /** Код статьи «Оплачено» (1С) — для сравнения построчно. */
  code: PayrollCalcLineCode;
  /** NUMERIC текстом; null — сумму ФОТ не считает (почасовые условия). */
  amount: string | null;
  /** Из скольких дней: рабочих (у переработки — выходов) из нормы. */
  days?: { worked: number; norm: number | null };
  /** Только у переработки: часы в будни по корректировкам. */
  hours?: number;
  /** Только у доли бригады: КТУ и учтённые часы, по которым она посчитана. */
  brigade?: { ktu: string; hours: number };
}

/** Доля сотрудника в зафиксированном расчёте одной бригады. */
export interface IBrigadeShareFact {
  /** NUMERIC текстом; null — доли нет (выработка не введена или расчёт с ошибкой). */
  amount: string | null;
  ktu: string;
  countedMinutes: number;
  distribution: 'ok' | 'no_output' | 'nothing_to_distribute' | 'error';
}

export interface IPayrollCalcDeduction {
  kind_id: number;
  kind: string;
  amount: string;
}

/** Строка условий оплаты, задевающая месяц. Суммы — NUMERIC текстом. */
export interface ICalcTermsRow {
  effective_from: string;
  effective_to: string | null;
  calc_type: 'salary' | 'hourly';
  monthly_salary: string | null;
  bonus_amount: string | null;
  proration_rounding: ProrationRounding;
}

export interface ICalcSegment {
  from: string;
  /** null — действует дальше. */
  to: string | null;
  calcType: 'salary' | 'hourly';
  salaryCents: number;
  bonusCents: number;
  rounding: ProrationRounding;
}

export interface IPlannedSupplementPeriod {
  amount: string;
  date_from: string;
  date_to: string | null;
}

/** Период «Без переработки»: YYYY-MM-DD, по — включительно, null — бессрочно. */
export interface IOvertimeStopPeriod {
  date_from: string;
  date_to: string | null;
}

export interface IPayrollCalcFacts {
  monthStart: string;
  monthEnd: string;
  normDays: number | null;
  workdayDates: readonly string[];
  dayoffDates: readonly string[];
  /** Норма часов месяца в минутах — знаменатель переработки в будни; null — нет. */
  normMinutes?: number | null;
  /** Переработка в будни по корректировкам: дата → минуты; дни бригады уже исключены. */
  overtimeMinutes?: Readonly<Record<string, number>>;
  /** «Без переработки»: в эти даты выходы сверх нормы и часы по корректировкам не оплачиваются. */
  overtimeStops?: readonly IOvertimeStopPeriod[];
  absenceDays: PayrollAbsenceDays;
  terms: readonly ICalcTermsRow[];
  plannedSupplements: readonly IPlannedSupplementPeriod[];
  /** Разовые доплаты месяца, сумма; null — нет. */
  oneTimeTotal: string | null;
  rateAllowances: readonly IPayslipRateAllowance[];
  deductions: readonly IPayrollCalcDeduction[];
  /** Доли бригад; их дни в workdayDates и dayoffDates уже не входят. */
  brigadeShares?: readonly IBrigadeShareFact[];
}

export interface IPayrollCalcResult {
  lines: IPayrollCalcLine[];
  deductions: IPayrollCalcDeduction[];
  accrued: string;
  deducted: string;
  /** Начислено − удержано, без НДФЛ. */
  net: string;
  missing: PayrollCalcMissing[];
}

const nextIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

const cents = (amount: string | null): number => (amount === null ? 0 : toCents(amount));

/** Строки условий → сегменты: соседние без смены вида оплаты, оклада, премии и округления — один сегмент. */
export const mergeTermsSegments = (rows: readonly ICalcTermsRow[]): ICalcSegment[] => {
  const segments: ICalcSegment[] = [];
  const sorted = [...rows].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  for (const row of sorted) {
    const segment: ICalcSegment = {
      from: row.effective_from,
      to: row.effective_to,
      calcType: row.calc_type,
      salaryCents: cents(row.monthly_salary),
      bonusCents: cents(row.bonus_amount),
      rounding: row.proration_rounding ?? 'ruble',
    };
    const previous = segments[segments.length - 1];
    if (
      previous
      && previous.to !== null
      && nextIsoDay(previous.to) === segment.from
      && previous.calcType === segment.calcType
      && previous.salaryCents === segment.salaryCents
      && previous.bonusCents === segment.bonusCents
      && previous.rounding === segment.rounding
    ) {
      previous.to = segment.to;
    } else {
      segments.push(segment);
    }
  }
  return segments;
};

const inRange = (date: string, from: string, to: string | null): boolean => date >= from && (to === null || date <= to);

/** Сумма × дни / норма, половина вверх до рубля; в копейках. */
export const prorateToRubleCents = (amountCents: number, days: number, norm: number): number => {
  const normCents = norm * 100;
  return Math.floor((2 * amountCents * days + normCents) / (2 * normCents)) * 100;
};

/** Сумма × минуты / норма минут, половина вверх до копейки; в копейках. */
export const prorateMinutesCents = (amountCents: number, minutes: number, normMinutes: number): number => (
  Math.floor((2 * amountCents * minutes + normMinutes) / (2 * normMinutes))
);

/** Дневная ставка до копейки (половина вверх) × дни; в копейках. */
export const prorateDailyKopeckCents = (amountCents: number, days: number, norm: number): number => (
  Math.floor((2 * amountCents + norm) / (2 * norm)) * days
);

/**
 * Дни оклада и выходы «Переработки»: рабочие дни по порядку до нормы, недостающее — первыми выходами месяца;
 * остальное (рабочие сверх нормы и прочие выходы) — «Переработка».
 */
export const splitByNorm = (
  workdayDates: readonly string[],
  dayoffDates: readonly string[],
  norm: number,
): { contract: string[]; overtime: string[] } => {
  const workdays = [...workdayDates].sort();
  const dayoffs = [...dayoffDates].sort();
  if (workdays.length >= norm) {
    return { contract: workdays.slice(0, norm), overtime: [...workdays.slice(norm), ...dayoffs].sort() };
  }
  const fill = norm - workdays.length;
  return { contract: [...workdays, ...dayoffs.slice(0, fill)].sort(), overtime: dayoffs.slice(fill) };
};

const MISSING_BY_ABSENCE: ReadonlyArray<[keyof PayrollAbsenceDays, PayrollCalcMissing]> = [
  ['vacation', 'vacation_pay'],
  ['sick', 'sick_pay'],
  ['educational_leave', 'educational_pay'],
];

/** Расчёт месяца по фактам — правила в шапке файла. */
export const buildPayrollCalc = (facts: IPayrollCalcFacts): IPayrollCalcResult => {
  const missing = new Set<PayrollCalcMissing>();
  const lines: IPayrollCalcLine[] = [];
  const norm = facts.normDays !== null && facts.normDays > 0 ? facts.normDays : null;
  const segments = mergeTermsSegments(facts.terms)
    .filter(segment => segment.from <= facts.monthEnd && (segment.to === null || segment.to >= facts.monthStart));
  const segmentOf = (date: string): ICalcSegment | null => (
    segments.find(segment => inRange(date, segment.from, segment.to)) ?? null
  );
  const overtimeStopped = (date: string): boolean => (
    (facts.overtimeStops ?? []).some(stop => inRange(date, stop.date_from, stop.date_to))
  );

  // Выходы сверх нормы — только при норме дней.
  let overtimeDays: string[] = [];
  if (norm === null) {
    if (facts.workdayDates.length > 0 || facts.dayoffDates.length > 0) missing.add('no_norm');
  } else {
    const { contract: contractDates, overtime: overtimeDates } = splitByNorm(facts.workdayDates, facts.dayoffDates, norm);
    // Оклад: по сегментам, каждый по своим датам.
    const wholeMonthSegment = segments.length === 1
      && segments[0].from <= facts.monthStart
      && (segments[0].to === null || segments[0].to >= facts.monthEnd);
    let contractCents = 0;
    let contractKnown = false;
    let contractUnknown = false;
    for (const segment of segments) {
      const days = contractDates.filter(date => inRange(date, segment.from, segment.to)).length;
      if (days === 0) continue;
      if (segment.calcType === 'hourly') {
        contractUnknown = true;
        missing.add('hourly');
        continue;
      }
      const base = segment.salaryCents + segment.bonusCents;
      contractKnown = true;
      if (wholeMonthSegment && days === norm) contractCents += base;
      else if (segment.rounding === 'daily_kopeck') contractCents += prorateDailyKopeckCents(base, days, norm);
      else contractCents += prorateToRubleCents(base, days, norm);
    }
    if (contractDates.some(date => segmentOf(date) === null)) missing.add('no_terms');
    if (contractKnown || contractUnknown) {
      lines.push({
        code: 'contract',
        amount: contractUnknown && !contractKnown ? null : centsToAmount(contractCents),
        days: { worked: contractDates.length, norm },
      });
    }

    // Премиальная: плановая доплата пропорционально дням оклада в её периоде.
    let bonusCents = 0;
    for (const period of facts.plannedSupplements) {
      const days = contractDates.filter(date => inRange(date, period.date_from, period.date_to)).length;
      if (days === 0) continue;
      const wholeMonth = period.date_from <= facts.monthStart && (period.date_to === null || period.date_to >= facts.monthEnd);
      bonusCents += wholeMonth && days === norm ? cents(period.amount) : prorateToRubleCents(cents(period.amount), days, norm);
    }
    if (bonusCents > 0) {
      lines.push({ code: 'bonus', amount: centsToAmount(bonusCents), days: { worked: contractDates.length, norm } });
    }

    // «Без переработки» — после добора нормы: выходы в окладе остаются.
    overtimeDays = overtimeDates.filter(date => !overtimeStopped(date));
  }

  // Переработка: выходы сверх нормы — днём, будни по корректировкам — часами; по окладу своей даты, одинарно.
  const daysBySegment = new Map<ICalcSegment, number>();
  for (const date of overtimeDays) {
    const segment = segmentOf(date);
    if (!segment) missing.add('no_terms');
    else daysBySegment.set(segment, (daysBySegment.get(segment) ?? 0) + 1);
  }
  const minutesBySegment = new Map<ICalcSegment, number>();
  const overtimeMinutes = Object.entries(facts.overtimeMinutes ?? {})
    .filter(([date, minutes]) => minutes > 0 && !overtimeStopped(date));
  const normMinutes = facts.normMinutes !== null && facts.normMinutes !== undefined && facts.normMinutes > 0
    ? facts.normMinutes
    : null;
  if (overtimeMinutes.length > 0 && normMinutes === null) missing.add('no_norm');
  for (const [date, minutes] of normMinutes === null ? [] : overtimeMinutes) {
    const segment = segmentOf(date);
    if (!segment) missing.add('no_terms');
    else minutesBySegment.set(segment, (minutesBySegment.get(segment) ?? 0) + minutes);
  }
  if (daysBySegment.size > 0 || minutesBySegment.size > 0) {
    let overtimeCents = 0;
    let overtimeUnknown = false;
    for (const [segment, count] of daysBySegment) {
      if (segment.calcType === 'hourly') overtimeUnknown = true;
      else if (norm !== null) overtimeCents += prorateToRubleCents(segment.salaryCents, count, norm);
    }
    for (const [segment, minutes] of minutesBySegment) {
      if (segment.calcType === 'hourly') overtimeUnknown = true;
      else if (normMinutes !== null) overtimeCents += prorateMinutesCents(segment.salaryCents, minutes, normMinutes);
    }
    if (overtimeUnknown) missing.add('hourly');
    const hours = [...minutesBySegment.values()].reduce((sum, minutes) => sum + minutes, 0) / 60;
    lines.push({
      code: 'overtime',
      amount: overtimeUnknown && overtimeCents === 0 ? null : centsToAmount(overtimeCents),
      days: { worked: overtimeDays.length, norm },
      ...(hours > 0 ? { hours: Math.round(hours * 100) / 100 } : {}),
    });
  }

  const shares = facts.brigadeShares ?? [];
  if (shares.length > 0) {
    const known = shares.filter(share => share.amount !== null);
    for (const share of shares.filter(item => item.amount === null)) {
      missing.add(share.distribution === 'error' ? 'brigade_error' : 'brigade_output');
    }
    lines.push({
      code: 'brigade',
      amount: known.length > 0 ? centsToAmount(known.reduce((sum, share) => sum + cents(share.amount), 0)) : null,
      brigade: {
        ktu: shares[0].ktu,
        hours: Math.round((shares.reduce((sum, share) => sum + share.countedMinutes, 0) / 60) * 100) / 100,
      },
    });
  }

  if (facts.oneTimeTotal !== null && cents(facts.oneTimeTotal) > 0) {
    lines.push({ code: 'supplement', amount: centsToAmount(cents(facts.oneTimeTotal)) });
  }
  for (const allowance of facts.rateAllowances) {
    if (allowance.code === 'travel') {
      lines.push({ code: 'travel', amount: allowance.amount, days: allowance.days });
    } else {
      // Квартира и доплата за общежитие — одна статья 1С «Компенсация проживания».
      lines.push({ code: 'housing', amount: allowance.amount });
    }
  }
  if (segments.length === 0 && facts.workdayDates.length > 0) missing.add('no_terms');

  for (const [status, code] of MISSING_BY_ABSENCE) {
    if (facts.absenceDays[status] > 0) missing.add(code);
  }

  const accruedCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
  const deductedCents = facts.deductions.reduce((sum, deduction) => sum + cents(deduction.amount), 0);
  return {
    lines,
    deductions: [...facts.deductions],
    accrued: centsToAmount(accruedCents),
    deducted: centsToAmount(deductedCents),
    net: centsToAmount(accruedCents - deductedCents),
    missing: [...missing],
  };
};
