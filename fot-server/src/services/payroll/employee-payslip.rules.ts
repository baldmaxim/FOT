/**
 * Расчётный лист в личном кабинете (миграция 353) — чистые правила сборки листка из двух источников:
 *  - '1c' — статьи «Оплачено» (суммы 1С, payroll-paid.service), строка на статью, суммы как есть;
 *  - 'fot' — расчёт ФОТ по закрытому табелю (payroll-calc.service): строки calc.lines и удержания видов «Справочника».
 * Источник на экране не показывается: оба дают один и тот же листок (код статьи — общий словарь «Оплачено»).
 *
 * Оклад/ставка в строке — только у расчёта ФОТ (сумма из него и посчитана). У месяца 1С оклада нет: 1С его не
 * передаёт, а условия ФОТ с ним расходятся (Есенов, август 2026: 1С 167 142,89 по двум окладам, в ФОТ — один).
 *
 * Выплаты — ведомости 1С за месяц начисления, по документу (у сотрудника бывает несколько строк одной ведомости и
 * две ведомости одного вида в один день). Сальдо = начислено − удержано − выплачено, только если ведомости есть:
 * без них сальдо было бы всем начисленным. Деньги — в целых копейках, NUMERIC-строки на выходе.
 */
import type { IPayrollCalcLine, IPayrollCalcResult } from './payroll-calc.rules.js';
import {
  PAYROLL_PAID_ACCRUAL_CODES,
  PAYROLL_PAID_DEDUCTION_CODES,
  PAYROLL_PAID_ITEM_CODES,
  type IPayrollPaidAmount,
  type PayrollPaidItemCode,
} from './payroll-paid.service.js';
import type { IEmployeePayout1c } from './payroll-1c-payouts.service.js';
import type { IPayslipWorkedDays } from './payroll-payslip.rules.js';
import { centsToAmount, toCents } from './payroll-summary.attribution.js';

/** Строка листка: code — статья «Оплачено» или строки ФОТ (подпись на фронте); name — готовая подпись. */
export interface IEmployeePayslipLine {
  key: string;
  code: string | null;
  name: string | null;
  amount: string;
}

/** Часть оклада ФОТ-месяца: оклад ₽/мес или ставка ₽/ч на своём периоде; days — отработанные дни части. */
export interface IEmployeePayslipSalaryPart {
  calc_type: 'salary' | 'hourly';
  from: string;
  to: string;
  amount: string;
  days: number | null;
}

/** Ведомость выплаты за месяц начисления — строки одного документа сложены. */
export interface IEmployeePayslipPayout {
  document_id: number;
  doc_number: string;
  doc_date: string;
  payment_method: string;
  amount: string;
}

export interface IEmployeePayslipReady {
  state: 'ready';
  month: string;
  full_name: string;
  /** Текущая должность (истории должностей нет). */
  position_name: string | null;
  period_from: string | null;
  period_to: string | null;
  /** null — дней по табелю нет: без «за N дней». */
  worked_days: IPayslipWorkedDays | null;
  salary_parts: IEmployeePayslipSalaryPart[];
  accruals: IEmployeePayslipLine[];
  accrued_total: string;
  deductions: IEmployeePayslipLine[];
  deducted_total: string;
  payouts: IEmployeePayslipPayout[];
  /** null — ведомостей за месяц нет. */
  paid_total: string | null;
  balance: string | null;
}

export interface IEmployeePayslipNotReady {
  state: 'not_ready';
  month: string;
}

export type EmployeePayslip = IEmployeePayslipReady | IEmployeePayslipNotReady;

export interface IEmployeePayslipHeader {
  month: string;
  full_name: string;
  position_name: string | null;
  period: { from: string; to: string } | null;
  worked_days: IPayslipWorkedDays | null;
}

const sumCents = (amounts: readonly string[]): number => amounts.reduce((sum, amount) => sum + toCents(amount), 0);

/** Ведомости по документу: сумма строк в копейках, по дате и номеру. */
export const groupPayouts = (rows: readonly IEmployeePayout1c[]): IEmployeePayslipPayout[] => {
  const byDocument = new Map<number, { doc: IEmployeePayout1c; cents: number }>();
  for (const row of rows) {
    const entry = byDocument.get(row.document_id);
    if (entry) entry.cents += toCents(row.amount);
    else byDocument.set(row.document_id, { doc: row, cents: toCents(row.amount) });
  }
  return [...byDocument.values()]
    .map(({ doc, cents }) => ({
      document_id: doc.document_id,
      doc_number: doc.doc_number,
      doc_date: doc.doc_date,
      payment_method: doc.payment_method,
      amount: centsToAmount(cents),
    }))
    .sort((a, b) => a.doc_date.localeCompare(b.doc_date) || a.doc_number.localeCompare(b.doc_number));
};

/** Итоги, выплаты и сальдо — общий хвост обоих источников. */
const finish = (
  header: IEmployeePayslipHeader,
  salaryParts: IEmployeePayslipSalaryPart[],
  accruals: IEmployeePayslipLine[],
  deductions: IEmployeePayslipLine[],
  payoutRows: readonly IEmployeePayout1c[],
): IEmployeePayslipReady => {
  const accruedCents = sumCents(accruals.map(line => line.amount));
  const deductedCents = sumCents(deductions.map(line => line.amount));
  const payouts = groupPayouts(payoutRows);
  const paidCents = payouts.length > 0 ? sumCents(payouts.map(payout => payout.amount)) : null;
  return {
    state: 'ready',
    month: header.month,
    full_name: header.full_name,
    position_name: header.position_name,
    period_from: header.period?.from ?? null,
    period_to: header.period?.to ?? null,
    worked_days: header.worked_days,
    salary_parts: salaryParts,
    accruals,
    accrued_total: centsToAmount(accruedCents),
    deductions,
    deducted_total: centsToAmount(deductedCents),
    payouts,
    paid_total: paidCents === null ? null : centsToAmount(paidCents),
    balance: paidCents === null ? null : centsToAmount(accruedCents - deductedCents - paidCents),
  };
};

const ACCRUAL_SET = new Set<PayrollPaidItemCode>(PAYROLL_PAID_ACCRUAL_CODES);
const DEDUCTION_SET = new Set<PayrollPaidItemCode>(PAYROLL_PAID_DEDUCTION_CODES);
const ITEM_ORDER = new Map<string, number>(PAYROLL_PAID_ITEM_CODES.map((code, index) => [code, index]));

/** Листок месяца 1С: статьи «Оплачено» месяца, нулевые не показываются. */
export const buildPayslipFrom1c = (
  header: IEmployeePayslipHeader,
  paid: readonly IPayrollPaidAmount[],
  payoutRows: readonly IEmployeePayout1c[],
): IEmployeePayslipReady => {
  const rows = paid
    .filter(row => row.month === header.month && toCents(row.amount) !== 0)
    .sort((a, b) => (ITEM_ORDER.get(a.item) ?? 0) - (ITEM_ORDER.get(b.item) ?? 0));
  const toLine = (row: IPayrollPaidAmount): IEmployeePayslipLine => ({
    key: row.item,
    code: row.item,
    name: null,
    amount: centsToAmount(toCents(row.amount)),
  });
  return finish(
    header,
    [],
    rows.filter(row => ACCRUAL_SET.has(row.item)).map(toLine),
    rows.filter(row => DEDUCTION_SET.has(row.item)).map(toLine),
    payoutRows,
  );
};

/** Пропуски расчёта, при которых листок ФОТ неполон: нет отпускных/больничных/учебных из 1С. */
const INCOMPLETE_MISSING = new Set(['vacation_pay', 'sick_pay', 'educational_pay']);

/**
 * Можно ли показывать расчёт ФОТ сотруднику: итог известен, нет неполных отпускных/больничных и у каждой строки есть
 * сумма. Иначе листок «ещё не готов» — частичная сумма выглядела бы окончательной.
 */
export const isFotCalcComplete = (calc: IPayrollCalcResult): boolean => (
  calc.net !== null
  && !calc.missing.some(item => INCOMPLETE_MISSING.has(item))
  && calc.lines.every(line => line.amount !== null)
);

/** Части оклада из строки «По трудовому договору» расчёта ФОТ. */
export const salaryPartsOf = (lines: readonly IPayrollCalcLine[]): IEmployeePayslipSalaryPart[] => {
  const contract = lines.find(line => line.code === 'contract');
  return (contract?.parts ?? []).flatMap((part): IEmployeePayslipSalaryPart[] => {
    if (part.kind === 'salary') {
      return [{ calc_type: 'salary', from: part.from, to: part.to, amount: part.salary, days: part.days }];
    }
    if (part.kind === 'hourly') {
      return [{ calc_type: 'hourly', from: part.from, to: part.to, amount: part.rate, days: null }];
    }
    return [];
  });
};

/** Листок месяца ФОТ: строки расчёта (нулевые не показываются) и удержания видов «Справочника». */
export const buildPayslipFromFot = (
  header: IEmployeePayslipHeader,
  calc: IPayrollCalcResult,
  payoutRows: readonly IEmployeePayout1c[],
): IEmployeePayslipReady => {
  const accruals = calc.lines
    .filter(line => line.amount !== null && toCents(line.amount) !== 0)
    .map(line => ({ key: line.code, code: line.code, name: null, amount: centsToAmount(toCents(line.amount!)) }));
  const deductions = calc.deductions
    .filter(item => toCents(item.amount) !== 0)
    .map(item => ({
      key: `deduction-kind-${item.kind_id}`,
      code: null,
      name: item.kind,
      amount: centsToAmount(toCents(item.amount)),
    }));
  return finish(header, salaryPartsOf(calc.lines), accruals, deductions, payoutRows);
};
