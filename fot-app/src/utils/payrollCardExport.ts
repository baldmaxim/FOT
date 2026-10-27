/**
 * «Экспорт» карточки сотрудника «Зарплаты»: два листа xlsx — «Условия» и «История выплат».
 * Снимок собирается здесь, сервер только оформляет книгу (POST /payroll/terms/card/export).
 * Деньги — рублями числом (в Excel — числа), прочерк и даты — текстом, как в карточке.
 */
import type { IEmployeePayout1c } from '../services/payroll1cPayoutsService';
import {
  CALC_TYPE_LABELS,
  STAFF_CATEGORY_LABELS,
  type IPayrollPaidAmount,
  type IPayrollTermsRow,
} from '../services/payrollService';
import { formatDate } from './formatMoney';
import { formatAccrualMonthLabel } from './payrollAccruals';
import { paidCellKey, paidHistory, paidItemTotal, visiblePaidGroups } from './payrollPaid';
import { travelAllowance } from './payrollRates';
import { payrollRowCategory } from './payrollTermsForm';
import type { ITableExportSnapshot } from './tableView';

/** Лист книги: снимок таблицы без имени файла. */
export type PayrollCardSheet = Omit<ITableExportSnapshot, 'file_name'>;

export interface IPayrollCardExport {
  file_name: string;
  /** Порядок — как листы на сервере: условия, история выплат. */
  sheets: [PayrollCardSheet, PayrollCardSheet];
}

const DASH = '—';
/** Ограничения снимка на сервере (table-snapshot-export.ts). */
const MAX_TITLE = 200;
const MAX_SUBTITLE = 300;

export const PAYROLL_CARD_NO_PAYOUTS = 'Выплат из 1С пока нет';

/** NUMERIC строкой или числом → рубли числом; пусто и мусор — null. */
const toNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const orDash = (value: string | number | null): string | number => value ?? DASH;

/** «Итого» условий — оклад + премия в копейках; почасовая и без сумм — null («—»), как в карточке. */
const termsTotal = (row: IPayrollTermsRow): number | null => {
  if (row.calc_type !== 'salary') return null;
  const parts = [toNumber(row.monthly_salary), toNumber(row.bonus_amount)];
  if (parts.every(part => part === null)) return null;
  return parts.reduce<number>((sum, part) => sum + Math.round((part ?? 0) * 100), 0) / 100;
};

/**
 * Лист «Условия»: показатель — значение. Без условий на дату (terms_id = null) — вид оплаты, суммы и «Действует с»
 * прочерком, без умолчаний формы; категория, проживание, проезд и плановая доплата от условий не зависят.
 * Значения — сохранённые на момент открытия карточки (row), несохранённый ввод окна «Расчётов» не попадает.
 */
export const buildPayrollTermsSheet = (row: IPayrollTermsRow, asOfDate: string): PayrollCardSheet => {
  const hasTerms = row.terms_id !== null;
  const hourly = hasTerms && row.calc_type === 'hourly';
  const category = payrollRowCategory(row);
  const hasSupplement = toNumber(row.planned_supplement_amount) !== null;
  const subtitle = [
    row.department_name,
    row.position_name,
    row.tab_number ? `таб. № ${row.tab_number}` : null,
    `Условия на ${formatDate(asOfDate)}`,
  ].filter(Boolean).join(' · ');

  const rows: Array<[string, string | number | null]> = [
    ['Категория', STAFF_CATEGORY_LABELS[category]],
    ['Вид оплаты', hasTerms && row.calc_type ? CALC_TYPE_LABELS[row.calc_type] : DASH],
    [
      hourly ? 'Часовая ставка, ₽/час' : 'Оклад, ₽/мес',
      hasTerms ? orDash(toNumber(hourly ? row.hourly_rate : row.monthly_salary)) : DASH,
    ],
    ['Премиальная часть, ₽/мес', hasTerms ? orDash(toNumber(row.bonus_amount)) : DASH],
    ['Итого, ₽/мес', hasTerms ? orDash(termsTotal(row)) : DASH],
    ['Действует с', hasTerms ? formatDate(row.effective_from) : DASH],
    ['Проживание, ₽/мес', orDash(toNumber(row.housing_compensation))],
    ['Проезд, ₽/мес', orDash(toNumber(travelAllowance(category, row)))],
    ['Плановая доплата, ₽/мес', orDash(toNumber(row.planned_supplement_amount))],
    ['Плановая доплата с', hasSupplement ? formatDate(row.planned_supplement_from) : DASH],
    ['Плановая доплата по', hasSupplement ? formatDate(row.planned_supplement_to) : DASH],
  ];

  return {
    title: (row.full_name ?? 'Сотрудник').slice(0, MAX_TITLE),
    subtitle: subtitle.slice(0, MAX_SUBTITLE),
    // «Значение» — денежный столбец: суммы числом с копейками, подписи и даты остаются текстом.
    columns: [{ label: 'Показатель', type: 'text' }, { label: 'Значение', type: 'money' }],
    rows: rows.map(cells => ({ cells })),
  };
};

/**
 * Лист «История выплат»: месяц — строка (новые сверху), «Начислено», «Удержано», «К выплате» и статьи 1С,
 * по которым есть сумма хоть в одном месяце (порядок и подписи — PAYROLL_PAID_GROUPS). Внизу «Итого» по всем
 * столбцам в копейках. Сумм нет — одна строка «Выплат из 1С пока нет».
 */
export const buildPaidHistorySheet = (
  fullName: string | null,
  paidRows: readonly IPayrollPaidAmount[],
  payouts: readonly IEmployeePayout1c[] = [],
): PayrollCardSheet => {
  const history = paidHistory(paidRows, payouts);
  const months = history.months.map(entry => entry.month);
  const items = visiblePaidGroups(months, history.amounts).flatMap(group => group.items);
  const columns: PayrollCardSheet['columns'] = [
    { label: 'Месяц', type: 'text' },
    { label: 'Начислено', type: 'money' },
    { label: 'Удержано', type: 'money' },
    { label: 'К выплате', type: 'money' },
    { label: 'Перечислено (1С)', type: 'money' },
    ...items.map(item => ({ label: item.label, type: 'money' as const })),
  ];
  const base = { title: 'История выплат', subtitle: (fullName ?? 'Сотрудник').slice(0, MAX_SUBTITLE), columns };

  if (history.months.length === 0) {
    return { ...base, rows: [{ cells: [PAYROLL_CARD_NO_PAYOUTS, null, null, null, null] }] };
  }

  return {
    ...base,
    rows: [
      ...history.months.map(entry => ({
        cells: [
          formatAccrualMonthLabel(entry.month, true),
          entry.totals.accrued,
          entry.totals.deducted,
          entry.payout,
          entry.transferred,
          ...items.map(item => history.amounts.get(paidCellKey(entry.month, item.code)) ?? null),
        ],
      })),
      {
        cells: [
          'Итого',
          history.overall.accrued,
          history.overall.deducted,
          history.overallPayout,
          history.overallTransferred,
          ...items.map(item => paidItemTotal(months, history.amounts, item.code)),
        ],
      },
    ],
  };
};

/** Снимок карточки: asOfDate — дата условий (выборка списка), exportedAt — дата выгрузки по Москве (имя файла). */
export const buildPayrollCardExport = (params: {
  row: IPayrollTermsRow;
  paidRows: readonly IPayrollPaidAmount[];
  /** «Перечислено (1С)» — ведомости выплаты по месяцам начисления (справочно). */
  payouts?: readonly IEmployeePayout1c[];
  asOfDate: string;
  exportedAt: string;
}): IPayrollCardExport => {
  const { row, paidRows, payouts = [], asOfDate, exportedAt } = params;
  return {
    file_name: `Зарплата_${row.full_name ?? 'Сотрудник'}_${exportedAt}.xlsx`.replace(/[\s/\\:*?"<>|]+/g, '_'),
    sheets: [buildPayrollTermsSheet(row, asOfDate), buildPaidHistorySheet(row.full_name, paidRows, payouts)],
  };
};
