/**
 * «Экспорт» окна «Свод» в виде сводной ведомости 1С: строки «Свода» видимых на экране объектов (после отдела, вкладки,
 * поиска и фильтров столбцов) в порядке экрана — листья дерева. Дерево объект → категория → отдел → сотрудник, суммы
 * узлов, нумерацию и оформление собирает сервер (payroll-summary-tree-excel.service.ts).
 */
import type {
  IPayrollSummaryRow,
  IPayrollSummaryTreeLeaf,
  IPayrollSummaryTreeSnapshot,
} from '../services/payrollSummaryService';
import { formatMonthsLabel } from './monthsSelection';
import { moscowTodayIso, shiftMonth } from './moscowDate';
import { SUMMARY_ISSUE_LABELS, summaryRowKindTotals } from './payrollSummary';

/** Копейки → «178402.69», «-1.50»; null — null. */
const centsText = (cents: number | null): string | null => (cents === null ? null : (cents / 100).toFixed(2));

/** «2026-10-01» → «01.10.2026». */
const dateText = (iso: string): string => iso.split('-').reverse().join('.');

/**
 * Период ведомости по фактическим месяцам «Свода»: подряд — «с 01.07.2026 по 30.09.2026», как в 1С; вразброс —
 * «за июль 2026, сентябрь 2026» (диапазон соврал бы про пропущенные месяцы).
 */
export const summaryTreePeriodText = (months: ReadonlyArray<string>): string => {
  const sorted = [...months].sort();
  if (sorted.length === 0) return 'за весь период';
  const contiguous = sorted.every((month, index) => index === 0 || shiftMonth(sorted[index - 1], 1) === month);
  if (!contiguous) return `за ${formatMonthsLabel(sorted)}`;
  const last = sorted[sorted.length - 1];
  const [year, month] = last.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `за период с ${dateText(`${sorted[0]}-01`)} по ${dateText(`${last}-${String(lastDay).padStart(2, '0')}`)}`;
};

/** Листья: строки объектов в порядке objectKeys (экран); строки прочих объектов — нет. */
export const summaryTreeLeaves = (
  rows: ReadonlyArray<IPayrollSummaryRow>,
  objectKeys: ReadonlyArray<string>,
): IPayrollSummaryTreeLeaf[] => {
  const order = new Map(objectKeys.map((key, index) => [key, index]));
  return rows
    .filter(row => order.has(row.object_key))
    .map((row, index) => ({ row, index }))
    // Стабильно: внутри объекта порядок строк не важен — сервер сортирует отделы и ФИО сам.
    .sort((left, right) => order.get(left.row.object_key)! - order.get(right.row.object_key)! || left.index - right.index)
    .map(({ row }) => {
      const { accrued, deducted } = summaryRowKindTotals(row);
      const issues = (row.issues ?? []).map(issue => SUMMARY_ISSUE_LABELS[issue]);
      return {
        object_key: row.object_key,
        object_name: row.object_name,
        category: row.category,
        department: row.department,
        employee_id: row.employee_id,
        full_name: row.full_name,
        accrued: centsText(accrued),
        deducted: centsText(deducted),
        // Старый бэкенд выплат не отдаёт — поля нет, и сервер оставит «Выплачено» пустым, а не нулём.
        ...(row.paid_out !== undefined ? { paid_out: row.paid_out } : {}),
        not_counted: issues.length > 0 ? issues.join(', ') : null,
      };
    });
};

/** Название файла: «Свод_ЛИНИЯ_ИТР_2026-11-12.xlsx»; подпись отдела укорачивается — имя файла не длиннее 150. */
const SUBJECT_MAX_LENGTH = 100;

export const buildSummaryTreeSnapshot = (params: {
  rows: ReadonlyArray<IPayrollSummaryRow>;
  objectKeys: ReadonlyArray<string>;
  /** Фактические месяцы «Свода» (ответ сервера). */
  months: ReadonlyArray<string>;
  /** Выбранный отдел; нет — все отделы. */
  departmentLabel?: string;
  categoryLabel: string;
  /** Вкладка «Все»: «Выплачено» ещё и по рабочим и ИТР. */
  allCategories: boolean;
}): IPayrollSummaryTreeSnapshot => {
  const isoDate = moscowTodayIso();
  const scope = [params.departmentLabel ?? 'все отделы', ...(params.allCategories ? [] : [params.categoryLabel])].join(', ');
  const subject = `${params.departmentLabel ? `${params.departmentLabel} ` : ''}${params.categoryLabel}`.slice(0, SUBJECT_MAX_LENGTH);
  return {
    file_name: `Свод_${subject}_${isoDate}.xlsx`.replace(/[\s/\\:*?"<>|]+/g, '_'),
    title: `Сводная ведомость по объектам (${scope}) ${summaryTreePeriodText(params.months)}`,
    subtitle: `Категория: ${params.categoryLabel}. Дата выгрузки: ${dateText(isoDate)}`,
    split_paid: params.allCategories,
    leaves: summaryTreeLeaves(params.rows, params.objectKeys),
  };
};
