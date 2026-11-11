/**
 * Фильтры «Расчётов»: группа отделов (?group — ИТР / Рабочие, payroll-department-groups.ts) и объект месяца
 * (?object, как у «Свода»; профиль пары — payroll-month-profile.service / .rules). Разбор параметров и SQL пар
 * «сотрудник + месяц».
 *
 * Группа — по отделу (в СМ — по должности), от месяцев не зависит. Объект — только со списком месяцев (?paid_months=2026-09,…): без месяцев
 * («Условия оплаты») и с paid_months=all — 400, иначе молча проигнорированный фильтр показал бы всех.
 */
import { z } from 'zod';

import { payrollDismissedInMonthsSql, payrollWorkedInMonthsSql } from '../services/payroll/payroll-registry-scope.service.js';
import { PAYROLL_DEPARTMENT_GROUPS, type PayrollDepartmentGroup } from '../services/payroll/payroll-department-groups.js';
import type { IMonthFilter } from '../services/payroll/payroll-month-profile.rules.js';
import type { PayrollMonthsSelection } from './payroll-dictionary.helpers.js';

const groupSchema = z.enum(PAYROLL_DEPARTMENT_GROUPS as [PayrollDepartmentGroup, ...PayrollDepartmentGroup[]]);
/** Объект «Свода»: 'office', 'unknown' или id объекта СКУД. */
const objectSchema = z.union([z.literal('office'), z.literal('unknown'), z.string().uuid()]);

type ParseFailure = { ok: false; error: string; code: string };

/** ?group → группа отделов; не задана — null. */
export const parseDepartmentGroupQuery = (raw: unknown): { ok: true; group: PayrollDepartmentGroup | null } | ParseFailure => {
  if (raw === undefined) return { ok: true, group: null };
  const parsed = groupSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, group: parsed.data }
    : { ok: false, error: 'Некорректная группа отделов', code: 'INVALID_DEPARTMENT_GROUP' };
};

/** ?object → фильтр объекта месяца; не задан — null. */
export const parseMonthFilterQuery = (
  raw: Record<string, unknown>,
  paidMonths: PayrollMonthsSelection,
): { ok: true; filter: IMonthFilter | null } | ParseFailure => {
  if (raw.object === undefined) return { ok: true, filter: null };
  const parsed = objectSchema.safeParse(raw.object);
  if (!parsed.success) return { ok: false, error: 'Некорректный объект', code: 'INVALID_MONTH_FILTER' };
  if (paidMonths === null || paidMonths === 'all') {
    return { ok: false, error: 'Объект отбирается только за выбранные месяцы', code: 'MONTH_FILTER_NEEDS_MONTHS' };
  }
  return { ok: true, filter: { objectKey: parsed.data } };
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
