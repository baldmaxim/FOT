/**
 * Фильтры «Категория» и «Объект» «Расчётов» (?category, ?object): разбор параметров и SQL пар «сотрудник + месяц».
 * Профиль пары и отбор — payroll-month-profile.service / .rules.
 *
 * Матрица: фильтры действуют только со списком месяцев (?paid_months=2026-09,…). Без месяцев («Условия оплаты») и
 * с paid_months=all — 400: экран «весь период» не выбирает, а молча проигнорированный фильтр показал бы всех.
 */
import { z } from 'zod';

import { payrollDismissedInMonthsSql, payrollWorkedInMonthsSql } from '../services/payroll/payroll-registry-scope.service.js';
import type { IMonthFilter } from '../services/payroll/payroll-month-profile.rules.js';
import type { PayrollMonthsSelection } from './payroll-dictionary.helpers.js';

export const MONTH_FILTER_CATEGORIES = ['itr', 'office', 'worker'] as const;

const categorySchema = z.enum(MONTH_FILTER_CATEGORIES);
/** Объект «Свода»: 'office', 'unknown' или id объекта СКУД. */
const objectSchema = z.union([z.literal('office'), z.literal('unknown'), z.string().uuid()]);

const monthFilterSchema = z.object({
  category: categorySchema.optional(),
  object: objectSchema.optional(),
});

export type MonthFilterParseResult =
  | { ok: true; filter: IMonthFilter | null }
  | { ok: false; error: string; code: string };

/** ?category и ?object → фильтр; оба не заданы — null. */
export const parseMonthFilterQuery = (raw: Record<string, unknown>, paidMonths: PayrollMonthsSelection): MonthFilterParseResult => {
  const parsed = monthFilterSchema.safeParse({ category: raw.category, object: raw.object });
  if (!parsed.success) return { ok: false, error: 'Некорректный фильтр категории или объекта', code: 'INVALID_MONTH_FILTER' };
  const { category, object } = parsed.data;
  if (category === undefined && object === undefined) return { ok: true, filter: null };
  if (paidMonths === null || paidMonths === 'all') {
    return { ok: false, error: 'Категория и объект отбираются только за выбранные месяцы', code: 'MONTH_FILTER_NEEDS_MONTHS' };
  }
  return {
    ok: true,
    filter: { ...(category ? { category } : {}), ...(object ? { objectKey: object } : {}) },
  };
};

/** ?category для списка объектов (объект к своей выборке не применяется). */
export const parseObjectsCategory = (raw: unknown): { ok: true; category: IMonthFilter['category'] } | { ok: false } => {
  const parsed = categorySchema.optional().safeParse(raw);
  return parsed.success ? { ok: true, category: parsed.data } : { ok: false };
};

/**
 * Пары «сотрудник + месяц» строк «Расчётов»: после CTE buildBaseCtes (filtered), месяц — по тем же правилам, что
 * видимость строки, но для одного месяца: работающий — payrollWorkedInMonthsSql, уволенный — payrollDismissedInMonthsSql.
 * Иначе принятый в октябре получил бы профиль сентября, а уволенный — месяцы после увольнения.
 */
export const monthPairsSelectSql = (monthsParam: string, archiveParam: string): string => `
  SELECT f.employee_id, to_char(m.month_start, 'YYYY-MM') AS month
    FROM filtered f
    JOIN employees e ON e.id = f.employee_id
   CROSS JOIN LATERAL unnest(${monthsParam}::date[]) AS m(month_start)
   WHERE CASE WHEN e.employment_status = 'fired'
              THEN ${payrollDismissedInMonthsSql('e', 'ARRAY[m.month_start]')}
              ELSE ${payrollWorkedInMonthsSql('e.id', 'ARRAY[m.month_start]', archiveParam)}
         END`;
