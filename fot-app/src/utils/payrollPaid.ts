/**
 * «Оплачено» в карточке «Зарплата → Подробно»: статьи отчёта ЗУП «Начислено…» строками,
 * месяцы столбцами. Суммы вносятся вручную; пустая ячейка — суммы нет.
 * Коды статей — те же, что в CHECK миграции 295 и в payroll-paid.service.ts на сервере.
 */
import type { IPayrollPaidAmount, IPayrollPaidChange, PayrollPaidItemCode } from '../services/payrollService';

export interface IPayrollPaidItem {
  code: PayrollPaidItemCode;
  label: string;
  /** Минус допустим: перерасчёт бывает сторно прошлого периода. */
  allowNegative?: boolean;
}

/** Основные строки — над группой «Начисления и удержания». В комментарии — столбец отчёта ЗУП. */
export const PAYROLL_PAID_MAIN_ITEMS: readonly IPayrollPaidItem[] = [
  { code: 'contract', label: 'По трудовому договору' }, // 1.1.1 Начислено по графику
  { code: 'bonus', label: 'Премиальная' }, // 1.1.5 Ежемесячные доплаты и премии
  { code: 'sick_leave', label: 'Больничный' }, // 1.1.4 Оплата больничных листов
];

export const PAYROLL_PAID_GROUP_LABEL = 'Начисления и удержания';

/** Строки группы — в порядке столбцов отчёта ЗУП. */
export const PAYROLL_PAID_GROUP_ITEMS: readonly IPayrollPaidItem[] = [
  { code: 'overtime', label: 'Переработано' }, // 1.1.2
  { code: 'recalc_prev', label: 'Перерасчёт за предыдущий период', allowNegative: true }, // 1.1.6
  { code: 'severance', label: 'Выходное пособие при увольнении' }, // 1.3.2
  { code: 'supplement', label: 'Доплата' }, // 1.3.5
  { code: 'loan', label: 'Займ' }, // 1.3.7
  { code: 'vacation', label: 'Оплата отпуска' }, // 1.3.13
  { code: 'travel', label: 'Проезд' }, // 1.3.16
  { code: 'writ_deduction', label: 'Удержание по исп. листу' }, // 1.3.18
];

/** Все строки сверху вниз — порядок обхода ячеек совпадает с Tab. */
export const PAYROLL_PAID_ITEMS: readonly IPayrollPaidItem[] = [...PAYROLL_PAID_MAIN_ITEMS, ...PAYROLL_PAID_GROUP_ITEMS];

export const paidCellKey = (month: string, item: PayrollPaidItemCode): string => `${month}:${item}`;

/** id поля ячейки — по нему карточка ставит фокус на первую ячейку с ошибкой. */
export const paidCellId = (idPrefix: string, key: string): string => `${idPrefix}-paid-${key}`;

/** Сумма в ячейке: с разделителем тысяч, копейки — только если есть: «175 000», «55 057,30». */
export const formatPaidAmount = (value: number): string => value.toLocaleString('ru-RU', {
  minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  maximumFractionDigits: 2,
});

/** Сохранённые суммы по ключу ячейки — в виде ячейки: «175000.00» → «175 000». */
export const toPaidValues = (rows: readonly IPayrollPaidAmount[]): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const row of rows) values[paidCellKey(row.month, row.item)] = formatPaidAmount(Number(row.amount));
  return values;
};

/** Верх NUMERIC(12,2) — как на сервере. */
const MAX_MONEY = 9_999_999_999.99;
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Сумма из поля: пусто — null, ошибка — undefined. Пробелы (в том числе неразрывные из Excel)
 * отбрасываются, запятая — как точка: «175 000,00» из отчёта вставляется как есть.
 */
export const parsePaidAmount = (raw: string, allowNegative = false): number | null | undefined => {
  const normalized = raw.replace(/\s+/g, '').replace(',', '.');
  if (!normalized) return null;
  if (!AMOUNT_PATTERN.test(normalized)) return undefined;
  const value = Number(normalized);
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MONEY) return undefined;
  if (value < 0 && !allowNegative) return undefined;
  return value;
};

export interface IPayrollPaidChanges {
  /** Ячейки, где сумма отличается от сохранённой. */
  changes: IPayrollPaidChange[];
  /** Ключи ячеек с ошибкой — в порядке обхода (первая — под фокус). */
  invalidKeys: string[];
}

/**
 * Изменённые ячейки: правка сравнивается с сохранённой суммой числом, поэтому «175000,00»
 * поверх «175 000» изменением не считается, а очищенная заполненная ячейка уходит как null.
 */
export const buildPaidChanges = (
  months: readonly string[],
  saved: Readonly<Record<string, string>>,
  edits: Readonly<Record<string, string>>,
): IPayrollPaidChanges => {
  const changes: IPayrollPaidChange[] = [];
  const invalidKeys: string[] = [];
  for (const item of PAYROLL_PAID_ITEMS) {
    for (const month of months) {
      const key = paidCellKey(month, item.code);
      if (!(key in edits)) continue;
      const next = parsePaidAmount(edits[key], item.allowNegative);
      if (next === undefined) {
        invalidKeys.push(key);
        continue;
      }
      const previous = key in saved ? parsePaidAmount(saved[key], true) ?? null : null;
      if (next !== previous) changes.push({ month, item: item.code, amount: next });
    }
  }
  return { changes, invalidKeys };
};
