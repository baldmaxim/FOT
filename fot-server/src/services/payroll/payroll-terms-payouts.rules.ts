/**
 * «Условия оплаты» → «Выплачено» (решение пользователя 09.11.2026): сумма сотрудника за месяц. Месяц из 1С — 1С,
 * иначе расчёт ФОТ, как «Свод» (payroll-summary-calc.rules.ts). Чистые функции, счёт в целых копейках.
 *
 *   1. В 1С есть «Зарплата» (contract) или вознаграждение по ГПХ (gph) — весь месяц из 1С: начислено − удержано, как
 *      было. ГПХ — оплата месяца человека на договоре ГПХ: расчёт ФОТ по окладу поверх неё задвоил бы месяц (прод
 *      09.11.2026: Баллиев, август — ГПХ 150 075 + оклад ФОТ). «Свод» пока смотрит только на «Зарплату».
 *   2. Иначе ФОТ посчитан и его итог известен (то же условие, что у «Суммы» «Расчётов») — «К выплате» «Свода»:
 *      расчёт, разовые доплаты и удержания «Справочника», загруженная статья 1С заменяет свою. Без статей 1С это
 *      ровно «Сумма» «Расчётов»; ноль — ноль.
 *   3. ФОТ посчитан, итог неизвестен (выработка бригады не внесена, нет условий или нормы) — только загруженное из
 *      1С, нет его — null. Частичную сумму ФОТ не показываем, «Свод» тут даёт её с «Не посчитано».
 *   4. ФОТ не считался (не работал в месяце; в загруженном месяце — без условий и не в незагруженной бригаде) —
 *      1С, разовые и удержания, как «Свод»; ничего нет — null.
 */
import type { PayrollCalcWithPreliminary } from './payroll-calc.service.js';
import { PAYROLL_PAID_ACCRUAL_CODES, PAYROLL_PAID_DEDUCTION_CODES } from './payroll-paid.service.js';
import { mergeSummaryMonth, SUMMARY_OTHER_DEDUCTIONS, SUMMARY_PAYROLL_ITEM } from './payroll-summary-calc.rules.js';
import { toCents } from './payroll-summary.attribution.js';

const ACCRUAL_ITEMS: ReadonlySet<string> = new Set(PAYROLL_PAID_ACCRUAL_CODES);
const DEDUCTION_ITEMS: ReadonlySet<string> = new Set([...PAYROLL_PAID_DEDUCTION_CODES, SUMMARY_OTHER_DEDUCTIONS]);

/**
 * «К выплате» статей в копейках: «Начислено» минус «Удержано» (с «Прочими удержаниями» «Свода»), как payoutTotal
 * «Свода» на фронте. Ни одной статьи этих разделов — null.
 */
export const summaryPayoutCents = (cents: ReadonlyMap<string, number>): number | null => {
  let accrued: number | null = null;
  let deducted: number | null = null;
  for (const [item, value] of cents) {
    if (ACCRUAL_ITEMS.has(item)) accrued = (accrued ?? 0) + value;
    else if (DEDUCTION_ITEMS.has(item)) deducted = (deducted ?? 0) + value;
  }
  return accrued === null && deducted === null ? null : (accrued ?? 0) - (deducted ?? 0);
};

/** Статьи 1С, по которым месяц человека посчитан в 1С: «Зарплата» или вознаграждение по ГПХ. */
const ONE_C_PAY_ITEMS: readonly string[] = [SUMMARY_PAYROLL_ITEM, 'gph'];

/** Месяц человека из 1С целиком (правило 1): расчёт ФОТ ему не нужен. */
export const isTermsPayoutFrom1c = (paid: ReadonlyMap<string, string> | undefined): boolean => (
  ONE_C_PAY_ITEMS.some(item => paid?.has(item) ?? false)
);

const paidCents = (paid: ReadonlyMap<string, string>): Map<string, number> => (
  new Map([...paid].map(([item, amount]) => [item, toCents(amount)]))
);

/** Что известно о сотруднике за месяц. Суммы — NUMERIC текстом. */
export interface ITermsPayoutFacts {
  /** Статьи 1С «Оплачено»: статья → сумма. */
  paid: ReadonlyMap<string, string>;
  /** Расчёт ФОТ месяца; undefined — не считался. */
  calc: PayrollCalcWithPreliminary | undefined;
  /** Итог ФОТ известен: sumCalcColumns([[месяц, calc]]).net !== null, как у «Суммы» «Расчётов». */
  fotKnown: boolean;
  oneTime: ReadonlyArray<{ reason: string; amount: string }>;
  deductions: ReadonlyArray<{ kind: string; amount: string }>;
}

/** «Выплачено» за месяц в копейках; null — данных нет («—»). Известный ноль — 0. */
export const termsPayoutMonth = (facts: ITermsPayoutFacts): number | null => {
  if (isTermsPayoutFrom1c(facts.paid)) return summaryPayoutCents(paidCents(facts.paid));
  if (facts.calc !== undefined && !facts.fotKnown) {
    return facts.paid.size > 0 ? summaryPayoutCents(paidCents(facts.paid)) : null;
  }
  const merged = mergeSummaryMonth({
    paid: facts.paid,
    calc: facts.calc,
    oneTime: facts.oneTime,
    deductions: facts.deductions,
  });
  const total = summaryPayoutCents(merged.cents);
  // Итог ФОТ известен, а строк нет — «Сумма» «Расчётов» здесь 0,00.
  return total ?? (facts.calc !== undefined ? 0 : null);
};
