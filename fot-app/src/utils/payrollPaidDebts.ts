/**
 * Справочно к «Оплачено»: долги прошлых месяцев из ведомостей бригад 1С — как в ведомости: перенос удержаний
 * с прошлых периодов по видам, закрыто документом 1С, перенос на следующий период. «Погашено из зарплаты месяца» =
 * долг − закрыто − перенесено (не меньше нуля); долга с прошлых месяцев нет (только перенос на следующий —
 * новый долг) — «—». Расшифровка статьи «Погашение долгов прошлых месяцев» (prior_debts, миграция 334): нетто
 * долг − закрыто − перенесено уже в «Удержано», сам блок в итоги не добавляется. Суммы — в копейках.
 */
import type { IPayrollPaidDebt, PayrollPaidDebtCode } from '../services/payrollPaidDebtsService';

/** Виды долга — в порядке строк; подписи — как столбцы ведомости. */
export const PAYROLL_PAID_DEBT_KINDS: ReadonlyArray<{ code: PayrollPaidDebtCode; label: string }> = [
  { code: 'debt_day_salary', label: 'Оклад по дням' },
  { code: 'debt_correction', label: 'Корректировка удержаний' },
  { code: 'debt_workwear', label: 'Спецодежда' },
  { code: 'debt_tmc', label: 'ТМЦ' },
  { code: 'debt_property_damage', label: 'Порча имущества' },
  { code: 'debt_advance', label: 'Аванс' },
  { code: 'debt_fines', label: 'Акт нарушений из Витрины' },
  { code: 'debt_meals', label: 'Питание' },
];

export const PAID_DEBT_WRITTEN_OFF_LABEL = 'Закрыто документом 1С';
export const PAID_DEBT_CARRIED_LABEL = 'Перенесено на следующий месяц';
export const PAID_DEBT_REPAID_LABEL = 'Погашено из зарплаты месяца';

/** Месяц: виды долга с суммами, закрыто, перенесено, погашено — рубли; null — строки нет (у «Погашено» — долга не было). */
export interface IPaidDebtMonth {
  kinds: ReadonlyArray<{ code: PayrollPaidDebtCode; label: string; amount: number }>;
  writtenOff: number | null;
  carriedForward: number | null;
  repaid: number | null;
}

const toCents = (amount: string): number => Math.round(Number(amount) * 100);

/** Долги месяца YYYY-MM; строк за месяц нет — null (блок не показывается). */
export const paidDebtMonth = (rows: readonly IPayrollPaidDebt[], month: string): IPaidDebtMonth | null => {
  const cents = new Map<PayrollPaidDebtCode, number>();
  for (const row of rows) {
    if (row.month !== month) continue;
    const value = toCents(row.amount);
    if (Number.isFinite(value)) cents.set(row.line, (cents.get(row.line) ?? 0) + value);
  }
  if (cents.size === 0) return null;
  const kinds = PAYROLL_PAID_DEBT_KINDS
    .filter(kind => cents.has(kind.code))
    .map(kind => ({ ...kind, amount: (cents.get(kind.code) ?? 0) / 100 }));
  const debt = PAYROLL_PAID_DEBT_KINDS.reduce((sum, kind) => sum + (cents.get(kind.code) ?? 0), 0);
  const writtenOff = cents.get('written_off') ?? null;
  const carried = cents.get('carried_forward') ?? null;
  return {
    kinds,
    writtenOff: writtenOff === null ? null : writtenOff / 100,
    carriedForward: carried === null ? null : carried / 100,
    repaid: debt === 0 ? null : Math.max(0, debt - (writtenOff ?? 0) - (carried ?? 0)) / 100,
  };
};
