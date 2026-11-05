/**
 * «Свод»: суммы сотрудника за месяц из расчёта ФОТ и загруженных данных 1С (решение пользователя 05.11.2026). Чистые
 * функции, счёт в целых копейках.
 *
 *   1. В 1С есть «Зарплата» (contract) — ведомость загружена: весь месяц человека из 1С, расчёт не добавляется.
 *   2. Иначе — расчёт ФОТ, разовые доплаты и удержания «Справочника». Статья, загруженная из 1С, заменяет их сумму по
 *      этой статье целиком: разовая «Допработы» и «Допработы» 1С — одна и та же выплата, она не удваивается.
 *   3. Неизвестная сумма в ноль не превращается: что посчитать нельзя — в issues (столбец «Не посчитано»).
 */
import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import type { PayrollCalcMissing } from './payroll-calc.rules.js';
import type { PayrollPaidItemCode } from './payroll-paid.service.js';
import { toCents } from './payroll-summary.attribution.js';

/** Статья 1С, по которой видно, что ведомость месяца загружена. */
export const SUMMARY_PAYROLL_ITEM: PayrollPaidItemCode = 'contract';

/** Столбец удержаний «Справочника», для вида которых нет статьи 1С. */
export const SUMMARY_OTHER_DEDUCTIONS = 'other_deductions';

export type SummaryItemCode = PayrollPaidItemCode | typeof SUMMARY_OTHER_DEDUCTIONS;

/**
 * Почему суммы нет или она неполна. Из расчёта — кроме no_days (итог есть, в таблице у человека просто ноль);
 * brigade_open — бригада месяца не посчитана, no_timesheet — месяц посчитать не по чему (1-е число текущего месяца),
 * unknown_amount — строка расчёта без суммы и без причины (страховка, как в столбцах «Расчётов»).
 */
export type SummaryIssue =
  | Exclude<PayrollCalcMissing, 'no_days'>
  | 'brigade_open'
  | 'no_timesheet'
  | 'unknown_amount';

/** Названия без регистра и лишних пробелов: основания и виды заводятся пользователями. */
const normalizeName = (name: string): string => name.replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');

const byName = (entries: ReadonlyArray<readonly [string, SummaryItemCode]>): ReadonlyMap<string, SummaryItemCode> => (
  new Map(entries.map(([name, item]) => [normalizeName(name), item]))
);

/** Основание разовой доплаты → статья 1С, куда та же выплата попадает при загрузке ведомости. */
const ONE_TIME_REASON_ITEMS = byName([
  ['Выходное пособие при увольнении', 'severance'],
  ['Доплата', 'supplement'],
  ['Допработы', 'extra_work'],
  ['Замещение', 'substitution'],
  ['Зарплата', 'salary_extra'],
  ['Квартира', 'housing'],
  ['Компенсация проживания', 'housing'],
  ['Компенсация использования личного а/м', 'car_compensation'],
  ['Матпомощь', 'material_aid'],
  ['Перерасход п/о средств', 'imprest_overspend'],
  ['Перерасчет з/пл', 'recalc_prev'],
  ['Премия', 'premium'],
  ['Премия % по договору', 'premium_contract'],
  ['Проезд', 'travel'],
  ['Резерв', 'reserve'],
]);

/** Вид удержания «Справочника» → статья удержаний 1С. */
const DEDUCTION_KIND_ITEMS = byName([
  ['% Займа', 'loan_interest'],
  ['Алименты', 'alimony'],
  ['Банковские издержки по исп. листам', 'bank_fees'],
  ['Займ', 'loan_repayment'],
  ['Нарушение техники безопасности', 'safety_fine'],
  ['Питание', 'meals'],
  ['Спецодежда', 'workwear'],
  ['ТМЦ', 'tmc'],
  ['Транспортные затраты', 'transport'],
  ['Удержание по исп. листу', 'writ_deduction'],
  ['Штрафы', 'fines'],
]);

/** Основание не сопоставлено — «Разовая доплата». */
export const oneTimeReasonItem = (reason: string): SummaryItemCode => (
  ONE_TIME_REASON_ITEMS.get(normalizeName(reason)) ?? 'supplement'
);

/** Вид без статьи 1С — «Прочие удержания». */
export const deductionKindItem = (kind: string): SummaryItemCode => (
  DEDUCTION_KIND_ITEMS.get(normalizeName(kind)) ?? SUMMARY_OTHER_DEDUCTIONS
);

/** Что известно о сотруднике за месяц. Суммы — NUMERIC текстом. */
export interface ISummaryMonthFacts {
  /** Суммы 1С: статья → сумма; статьи без суммы нет (0 — есть, он тоже загружен). */
  paid: ReadonlyMap<string, string>;
  /** Расчёт ФОТ месяца; undefined — не считался. */
  calc: PayrollCalcWithPreliminary | undefined;
  oneTime: ReadonlyArray<{ reason: string; amount: string }>;
  deductions: ReadonlyArray<{ kind: string; amount: string }>;
}

export interface ISummaryMonthAmounts {
  /** Статья → копейки. */
  cents: Map<string, number>;
  issues: SummaryIssue[];
  /** Показывать ли человека: есть суммы 1С, ненулевая сумма или причина «Не посчитано». */
  visible: boolean;
}

/** Нужен ли человеку расчёт: зарплата 1С уже загружена — месяц целиком из 1С. */
export const needsSummaryCalc = (paid: ReadonlyMap<string, string> | undefined): boolean => (
  !paid?.has(SUMMARY_PAYROLL_ITEM)
);

/** Отсутствия: сумм нет, но строки расчёта они без суммы не оставляют. */
const ABSENCE_ISSUES: ReadonlySet<PayrollCalcMissing> = new Set<PayrollCalcMissing>(['vacation_pay', 'sick_pay', 'educational_pay']);

const calcIssues = (calc: PayrollCalcWithPreliminary | undefined): SummaryIssue[] => {
  if (!calc) return [];
  if (calc.state === 'not_closed') {
    if (calc.reason === 'no_period') return [];
    return [calc.reason === 'brigade_open' ? 'brigade_open' : 'no_timesheet'];
  }
  const issues = calc.missing.filter((code): code is Exclude<PayrollCalcMissing, 'no_days'> => code !== 'no_days');
  const lineExplained = issues.some(code => !ABSENCE_ISSUES.has(code));
  return !lineExplained && calc.lines.some(line => line.amount === null) ? [...issues, 'unknown_amount'] : issues;
};

/** Суммы месяца по статьям: ведомость 1С целиком либо расчёт, поверх которого легли загруженные статьи. */
export const mergeSummaryMonth = (facts: ISummaryMonthFacts): ISummaryMonthAmounts => {
  const cents = new Map<string, number>();
  const add = (item: string, amount: string): void => {
    cents.set(item, (cents.get(item) ?? 0) + toCents(amount));
  };

  if (!needsSummaryCalc(facts.paid)) {
    for (const [item, amount] of facts.paid) add(item, amount);
    return { cents, issues: [], visible: true };
  }

  if (facts.calc && facts.calc.state !== 'not_closed') {
    for (const line of facts.calc.lines) {
      // Разовые — ниже, по основанию: одной суммой их не сопоставить со статьями 1С.
      if (line.code === 'supplement' || line.amount === null) continue;
      // Долю бригады ЗУП проводит той же статьёй, что оклад.
      add(line.code === 'brigade' ? SUMMARY_PAYROLL_ITEM : line.code, line.amount);
    }
  }
  for (const { reason, amount } of facts.oneTime) add(oneTimeReasonItem(reason), amount);
  for (const { kind, amount } of facts.deductions) add(deductionKindItem(kind), amount);

  // Загруженная статья заменяет сумму целиком, в том числе если в 1С по ней 0.
  for (const [item, amount] of facts.paid) cents.set(item, toCents(amount));

  const issues = calcIssues(facts.calc);
  const visible = facts.paid.size > 0 || issues.length > 0 || [...cents.values()].some(value => value !== 0);
  return { cents, issues, visible };
};
