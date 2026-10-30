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
 * - «Отпуска» (vacation) и «Больничный» (sick_leave) — суммы из 1С (решение пользователя 30.10.2026): статья
 *   «Оплачено» месяца (начислено ЗУП), а её строки нет — ведомости выплаты «Отпуска» / «Больничные листы» месяца
 *   начисления (перечислено). Источник — по наличию строки, не по сумме; дни отсутствия — в строке;
 * - «Удержано» — удержания «Справочника» за месяц по видам.
 * Итог «К выплате (ФОТ)» = начислено − удержано, без НДФЛ — как «Выплачено» из 1С. Отпускные и больничные без сумм
 * 1С и учебный отпуск ФОТ не считает: дни есть — итог помечается неполным (missing). Сумму строки посчитать нельзя
 * (почасовые условия, нет условий или нормы, доли бригады нет) — итог null: частичная сумма за итог не выдаётся.
 * Под строками — части (parts): из чего сумма, те же числа, что в ней.
 *
 * Сегменты: соседние строки условий с одинаковыми видом оплаты, окладом, премией и округлением склеиваются —
 * смена одной компенсации даёт новую строку условий, но не новую границу округления.
 * Деньги — целые копейки (Math.round(x * 100), как во всей «Зарплате»), наружу — строки с двумя знаками.
 */
import type { PayrollAbsenceDays } from './payroll-basis.service.js';
import type { IPayslipRateAllowance } from './payroll-payslip.rules.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';
import type { ProrationRounding } from './payroll-terms.service.js';

export type PayrollCalcLineCode =
  | 'contract' | 'brigade' | 'bonus' | 'supplement' | 'overtime' | 'travel' | 'housing' | 'vacation' | 'sick_leave';

/**
 * brigade_output — выработка не внесена на объекте, где у сотрудника есть учтённые часы (или у бригады ничего не
 * внесено); brigade_no_hours — до 336: выработка введена, делить не по чему (с 336 не выставляется, тип оставлен для
 * старых клиентов); brigade_error — расчёт бригады с ошибкой.
 */
export type PayrollCalcMissing =
  | 'no_norm' | 'no_terms' | 'hourly' | 'vacation_pay' | 'sick_pay' | 'educational_pay'
  | 'brigade_output' | 'brigade_no_hours' | 'brigade_error';

/**
 * Из чего сумма строки — расшифровка в листке. Части строятся там же, где сумма, и складываются в неё до копейки
 * (известные; неизвестная доля бригады — amount null). Деньги — NUMERIC текстом, периоды обрезаны границами месяца.
 */
export type PayrollCalcLinePart =
  | {
    kind: 'salary';
    from: string;
    to: string;
    salary: string;
    bonus: string;
    days: number;
    norm: number;
    /** whole — полный месяц одним сегментом, оклад как есть; daily_kopeck — дневная ставка до копейки × дни. */
    rounding: 'whole' | 'ruble' | 'daily_kopeck';
    daily_rate?: string;
    amount: string;
  }
  | { kind: 'planned_supplement'; from: string; to: string; base: string; days: number; norm: number; amount: string }
  | { kind: 'overtime_days'; from: string; to: string; salary: string; days: number; norm: number; amount: string }
  | {
    kind: 'overtime_hours';
    from: string;
    to: string;
    salary: string;
    minutes: number;
    norm_minutes: number;
    amount: string;
  }
  | { kind: 'travel'; rate: string; days: number; norm: number; amount: string }
  // Ставка за день и дни (миграция 339); у квартиры со сменой ставки в месяце ставки нет.
  | { kind: 'housing'; housing: 'apartment' | 'dormitory'; amount: string; rate?: string; days?: number }
  | { kind: 'one_time'; amount: string }
  /** Отпускные или больничные: статья «Оплачено» (начислено в 1С). */
  | { kind: 'paid_1c'; amount: string }
  /** Отпускные или больничные: ведомость выплаты 1С (перечислено); doc_date — YYYY-MM-DD. */
  | { kind: 'payout_1c'; doc_number: string; doc_date: string; amount: string }
  | {
    kind: 'brigade';
    department_id: string;
    /** Объект, на котором делилась выработка (336); null — у сотрудника нет учтённых часов на объектах. */
    object_key?: string | null;
    object_name?: string | null;
    /** Выработка объекта (без объекта — Σ выработок бригады); null — не внесена. */
    output: string | null;
    ktu_tenths: number;
    counted_minutes: number;
    /** Вес сотрудника — КТУ в десятых × минуты на объекте; total_weight — сумма весов объекта (тот же расчёт доли). */
    weight: number;
    total_weight: number;
    amount: string | null;
  };

export interface IPayrollCalcLine {
  /** Код статьи «Оплачено» (1С) — для сравнения построчно. */
  code: PayrollCalcLineCode;
  /** NUMERIC текстом; null — сумму ФОТ не считает (почасовые условия). */
  amount: string | null;
  /** Из скольких дней: рабочих (у переработки — выходов) из нормы. */
  days?: { worked: number; norm: number | null };
  /** Только у оклада: сколько выходов добрали норму (они в днях оклада). */
  filled_dayoffs?: number;
  /** Только у переработки: часы в будни по корректировкам. */
  hours?: number;
  /** Только у доли бригады: КТУ и учтённые часы, по которым она посчитана. */
  brigade?: { ktu: string; hours: number };
  parts?: PayrollCalcLinePart[];
}

/** Доля сотрудника на одном объекте бригады. */
export interface IBrigadeShareObjectFact {
  objectKey: string;
  objectName: string;
  /** Выработка объекта; null — не внесена. */
  output: string | null;
  countedMinutes: number;
  /** КТУ в десятых × минуты на объекте; totalWeight — Σ весов объекта. */
  weight: number;
  totalWeight: number;
  amount: string | null;
}

/** Доля сотрудника в расчёте одной бригады (зафиксированном или предварительном). */
export interface IBrigadeShareFact {
  departmentId: string;
  /** NUMERIC текстом — Σ долей по объектам; null — доли нет (выработка не внесена или расчёт с ошибкой). */
  amount: string | null;
  ktu: string;
  countedMinutes: number;
  distribution: 'ok' | 'no_output' | 'nothing_to_distribute' | 'error';
  /** Σ выработок бригады; null — ничего не внесено. */
  output: string | null;
  /** Объекты с учтёнными минутами сотрудника — части расшифровки. */
  objects: IBrigadeShareObjectFact[];
  /** Дни с часами в бригаде (по объектам расчёта) — доплата за общежитие по дням (миграция 339). */
  workedDates: string[];
}

/** КТУ '1.5' → 15 десятых. */
export const ktuTenths = (ktu: string): number => Math.round(Number(ktu) * 10);

/**
 * Факты долей бригады из строк её расчёта (по объектам, 336): у сотрудника — объекты, где у него есть учтённые
 * минуты, с выработкой, весом и Σ весов объекта из того же расчёта.
 */
export const brigadeShareFacts = (
  departmentId: string,
  distribution: IBrigadeShareFact['distribution'],
  rows: ReadonlyArray<{
    employee_id: number;
    ktu: string;
    counted_minutes: number;
    amount: string | null;
    objects?: ReadonlyArray<{
      object_key: string;
      counted_minutes: number;
      weight: number;
      amount: string | null;
      /** Часы по дням на объекте. */
      days?: Readonly<Record<string, number>>;
    }>;
  }>,
  objects: ReadonlyArray<{ object_key: string; object_name: string; output: string | null; total_weight: number }>,
): Map<number, IBrigadeShareFact> => {
  const byKey = new Map(objects.map(object => [object.object_key, object]));
  const outputs = objects.filter(object => object.output !== null);
  const output = outputs.length === 0
    ? null
    : centsToAmount(outputs.reduce((sum, object) => sum + cents(object.output!), 0));
  return new Map(rows.map(row => [Number(row.employee_id), {
    departmentId,
    amount: row.amount,
    ktu: row.ktu,
    countedMinutes: row.counted_minutes,
    distribution,
    output,
    objects: (row.objects ?? [])
      .filter(part => part.counted_minutes > 0)
      .map(part => ({
        objectKey: part.object_key,
        objectName: byKey.get(part.object_key)?.object_name ?? part.object_key,
        output: byKey.get(part.object_key)?.output ?? null,
        countedMinutes: part.counted_minutes,
        weight: part.weight,
        totalWeight: byKey.get(part.object_key)?.total_weight ?? 0,
        amount: part.amount,
      })),
    workedDates: [...new Set((row.objects ?? []).flatMap(part => Object.entries(part.days ?? {})
      .filter(([, hours]) => Number(hours) > 0)
      .map(([date]) => date)))].sort(),
  }]));
};

/** Ведомость выплаты 1С за отпуск или больничный: сумма сотрудника по документу. */
export interface IAbsencePayout1c {
  doc_number: string;
  /** YYYY-MM-DD. */
  doc_date: string;
  amount: string;
}

/** Суммы 1С за отпуск или больничный месяца. */
export interface IAbsencePay1c {
  code: 'vacation' | 'sick_leave';
  /** Статья «Оплачено» месяца; null — строки нет. */
  paid: string | null;
  /** Ведомости «Отпуска» / «Больничные листы» месяца начисления. */
  payouts: readonly IAbsencePayout1c[];
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
  /** Отпускные и больничные из 1С месяца. */
  absencePay1c?: readonly IAbsencePay1c[];
}

export interface IPayrollCalcResult {
  lines: IPayrollCalcLine[];
  deductions: IPayrollCalcDeduction[];
  accrued: string;
  deducted: string;
  /**
   * Начислено − удержано, без НДФЛ; null — итог неизвестен: сумму строки ФОТ не посчитал (почасовые условия, нет
   * условий или нормы, доли бригады нет). accrued тогда — только известная часть.
   */
  net: string | null;
  missing: PayrollCalcMissing[];
}

/** Причины, при которых итог «К выплате (ФОТ)» неизвестен: частичная сумма за итог не выдаётся. */
export const NET_UNKNOWN_MISSING: ReadonlySet<PayrollCalcMissing> = new Set<PayrollCalcMissing>([
  'hourly', 'no_terms', 'no_norm', 'brigade_output', 'brigade_no_hours', 'brigade_error',
]);

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

/** Дневная ставка до копейки, половина вверх; в копейках. */
const dailyKopeckRateCents = (amountCents: number, norm: number): number => Math.floor((2 * amountCents + norm) / (2 * norm));

/** Дневная ставка до копейки (половина вверх) × дни; в копейках. */
export const prorateDailyKopeckCents = (amountCents: number, days: number, norm: number): number => (
  dailyKopeckRateCents(amountCents, norm) * days
);

/** Период условий или доплаты в границах месяца — для подписи части. */
const clampPeriod = (from: string, to: string | null, monthStart: string, monthEnd: string): { from: string; to: string } => ({
  from: from < monthStart ? monthStart : from,
  to: to === null || to > monthEnd ? monthEnd : to,
});

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

/** Статус отсутствия, дни которого оплачивает строка 1С. */
const ABSENCE_BY_PAY_CODE: Record<IAbsencePay1c['code'], keyof PayrollAbsenceDays> = {
  vacation: 'vacation',
  sick_leave: 'sick',
};

/**
 * Строка отпускных или больничных из 1С: есть строка «Оплачено» — она (даже 0), нет — ведомости месяца; нет ни
 * того, ни другого — null.
 */
const absencePayLine = (pay: IAbsencePay1c, absenceDays: PayrollAbsenceDays): IPayrollCalcLine | null => {
  let amount: string;
  let parts: PayrollCalcLinePart[];
  if (pay.paid !== null) {
    amount = centsToAmount(cents(pay.paid));
    parts = [{ kind: 'paid_1c', amount }];
  } else if (pay.payouts.length > 0) {
    amount = centsToAmount(pay.payouts.reduce((sum, payout) => sum + cents(payout.amount), 0));
    parts = pay.payouts.map(({ doc_number, doc_date, amount: docAmount }) => ({
      kind: 'payout_1c', doc_number, doc_date, amount: centsToAmount(cents(docAmount)),
    }));
  } else {
    return null;
  }
  const days = absenceDays[ABSENCE_BY_PAY_CODE[pay.code]];
  return { code: pay.code, amount, ...(days > 0 ? { days: { worked: days, norm: null } } : {}), parts };
};

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
    const contractParts: PayrollCalcLinePart[] = [];
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
      const rounding = wholeMonthSegment && days === norm ? 'whole' : segment.rounding;
      const partCents = rounding === 'whole' ? base
        : rounding === 'daily_kopeck' ? prorateDailyKopeckCents(base, days, norm)
          : prorateToRubleCents(base, days, norm);
      contractCents += partCents;
      contractParts.push({
        kind: 'salary',
        ...clampPeriod(segment.from, segment.to, facts.monthStart, facts.monthEnd),
        salary: centsToAmount(segment.salaryCents),
        bonus: centsToAmount(segment.bonusCents),
        days,
        norm,
        rounding,
        ...(rounding === 'daily_kopeck' ? { daily_rate: centsToAmount(dailyKopeckRateCents(base, norm)) } : {}),
        amount: centsToAmount(partCents),
      });
    }
    if (contractDates.some(date => segmentOf(date) === null)) missing.add('no_terms');
    if (contractKnown || contractUnknown) {
      const dayoffs = new Set(facts.dayoffDates);
      const filledDayoffs = contractDates.filter(date => dayoffs.has(date)).length;
      lines.push({
        code: 'contract',
        amount: contractUnknown && !contractKnown ? null : centsToAmount(contractCents),
        days: { worked: contractDates.length, norm },
        ...(filledDayoffs > 0 ? { filled_dayoffs: filledDayoffs } : {}),
        parts: contractParts,
      });
    }

    // Премиальная: плановая доплата пропорционально дням оклада в её периоде.
    let bonusCents = 0;
    const bonusParts: PayrollCalcLinePart[] = [];
    for (const period of facts.plannedSupplements) {
      const days = contractDates.filter(date => inRange(date, period.date_from, period.date_to)).length;
      if (days === 0) continue;
      const wholeMonth = period.date_from <= facts.monthStart && (period.date_to === null || period.date_to >= facts.monthEnd);
      const partCents = wholeMonth && days === norm ? cents(period.amount) : prorateToRubleCents(cents(period.amount), days, norm);
      bonusCents += partCents;
      bonusParts.push({
        kind: 'planned_supplement',
        ...clampPeriod(period.date_from, period.date_to, facts.monthStart, facts.monthEnd),
        base: centsToAmount(cents(period.amount)),
        days,
        norm,
        amount: centsToAmount(partCents),
      });
    }
    if (bonusCents > 0) {
      lines.push({
        code: 'bonus',
        amount: centsToAmount(bonusCents),
        days: { worked: contractDates.length, norm },
        parts: bonusParts,
      });
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
    const overtimeParts: PayrollCalcLinePart[] = [];
    for (const [segment, count] of daysBySegment) {
      if (segment.calcType === 'hourly') {
        overtimeUnknown = true;
      } else if (norm !== null) {
        const partCents = prorateToRubleCents(segment.salaryCents, count, norm);
        overtimeCents += partCents;
        overtimeParts.push({
          kind: 'overtime_days',
          ...clampPeriod(segment.from, segment.to, facts.monthStart, facts.monthEnd),
          salary: centsToAmount(segment.salaryCents),
          days: count,
          norm,
          amount: centsToAmount(partCents),
        });
      }
    }
    for (const [segment, minutes] of minutesBySegment) {
      if (segment.calcType === 'hourly') {
        overtimeUnknown = true;
      } else if (normMinutes !== null) {
        const partCents = prorateMinutesCents(segment.salaryCents, minutes, normMinutes);
        overtimeCents += partCents;
        overtimeParts.push({
          kind: 'overtime_hours',
          ...clampPeriod(segment.from, segment.to, facts.monthStart, facts.monthEnd),
          salary: centsToAmount(segment.salaryCents),
          minutes,
          norm_minutes: normMinutes,
          amount: centsToAmount(partCents),
        });
      }
    }
    if (overtimeUnknown) missing.add('hourly');
    const hours = [...minutesBySegment.values()].reduce((sum, minutes) => sum + minutes, 0) / 60;
    lines.push({
      code: 'overtime',
      amount: overtimeUnknown && overtimeCents === 0 ? null : centsToAmount(overtimeCents),
      days: { worked: overtimeDays.length, norm },
      ...(hours > 0 ? { hours: Math.round(hours * 100) / 100 } : {}),
      parts: overtimeParts,
    });
  }

  const shares = facts.brigadeShares ?? [];
  if (shares.length > 0) {
    for (const share of shares.filter(item => item.amount === null)) {
      // Доля неизвестна только при ошибке или учтённых часах на объекте без выработки (выработка по объектам, 336).
      missing.add(share.distribution === 'error' ? 'brigade_error' : 'brigade_output');
    }
    // Неизвестна хоть одна доля — строки нет («—»), а не сумма известных частей.
    const unknown = shares.some(share => share.amount === null);
    lines.push({
      code: 'brigade',
      amount: unknown ? null : centsToAmount(shares.reduce((sum, share) => sum + cents(share.amount), 0)),
      brigade: {
        ktu: shares[0].ktu,
        hours: Math.round((shares.reduce((sum, share) => sum + share.countedMinutes, 0) / 60) * 100) / 100,
      },
      // Часть — на объект; у сотрудника без учтённых часов на объектах — одна часть бригады целиком.
      parts: shares.flatMap((share): PayrollCalcLinePart[] => (share.objects.length > 0
        ? share.objects.map(object => ({
          kind: 'brigade' as const,
          department_id: share.departmentId,
          object_key: object.objectKey,
          object_name: object.objectName,
          output: object.output,
          ktu_tenths: ktuTenths(share.ktu),
          counted_minutes: object.countedMinutes,
          weight: object.weight,
          total_weight: object.totalWeight,
          amount: object.amount === null ? null : centsToAmount(cents(object.amount)),
        }))
        : [{
          kind: 'brigade' as const,
          department_id: share.departmentId,
          object_key: null,
          object_name: null,
          output: share.output,
          ktu_tenths: ktuTenths(share.ktu),
          counted_minutes: share.countedMinutes,
          weight: 0,
          total_weight: 0,
          amount: share.amount === null ? null : centsToAmount(cents(share.amount)),
        }])),
    });
  }

  if (facts.oneTimeTotal !== null && cents(facts.oneTimeTotal) > 0) {
    const amount = centsToAmount(cents(facts.oneTimeTotal));
    lines.push({ code: 'supplement', amount, parts: [{ kind: 'one_time', amount }] });
  }
  for (const allowance of facts.rateAllowances) {
    if (allowance.code === 'travel') {
      const travelParts: PayrollCalcLinePart[] = allowance.rate !== undefined && allowance.days
        ? [{ kind: 'travel', rate: allowance.rate, days: allowance.days.worked, norm: allowance.days.norm, amount: allowance.amount }]
        : [];
      lines.push({ code: 'travel', amount: allowance.amount, days: allowance.days, parts: travelParts });
    } else {
      // Квартира и доплата за общежитие — одна статья 1С «Компенсация проживания».
      const housing = allowance.code === 'housing' ? 'apartment' : 'dormitory';
      const part: PayrollCalcLinePart = {
        kind: 'housing',
        housing,
        amount: allowance.amount,
        ...(allowance.rate !== undefined ? { rate: allowance.rate } : {}),
        ...(allowance.housing_days !== undefined ? { days: allowance.housing_days } : {}),
      };
      lines.push({ code: 'housing', amount: allowance.amount, parts: [part] });
    }
  }
  if (segments.length === 0 && facts.workdayDates.length > 0) missing.add('no_terms');

  // Отпуск, затем больничный — порядок не зависит от того, откуда пришли суммы.
  const paidAbsences = new Set<keyof PayrollAbsenceDays>();
  for (const code of ['vacation', 'sick_leave'] as const) {
    const pay = facts.absencePay1c?.find(item => item.code === code);
    const line = pay ? absencePayLine(pay, facts.absenceDays) : null;
    if (!line) continue;
    lines.push(line);
    paidAbsences.add(ABSENCE_BY_PAY_CODE[code]);
  }
  for (const [status, code] of MISSING_BY_ABSENCE) {
    if (facts.absenceDays[status] > 0 && !paidAbsences.has(status)) missing.add(code);
  }

  const accruedCents = lines.reduce((sum, line) => sum + cents(line.amount), 0);
  const deductedCents = facts.deductions.reduce((sum, deduction) => sum + cents(deduction.amount), 0);
  const netKnown = ![...missing].some(code => NET_UNKNOWN_MISSING.has(code)) && lines.every(line => line.amount !== null);
  return {
    lines,
    deductions: [...facts.deductions],
    accrued: centsToAmount(accruedCents),
    deducted: centsToAmount(deductedCents),
    net: netKnown ? centsToAmount(accruedCents - deductedCents) : null,
    missing: [...missing],
  };
};
