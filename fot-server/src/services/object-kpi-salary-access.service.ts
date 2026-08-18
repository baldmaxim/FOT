import { isEconomicsHead } from './object-kpi-roles-cache.service.js';
import type { ObjectKpiHistoryRow } from './object-kpi-history.service.js';

/**
 * Видимость оклада руководителя строительства (object_kpi_assignments.salary_amount).
 *
 * Модалку «Назначения» и карточку объекта открывает и экономист объекта, а «Историю» —
 * любой, у кого есть доступ к объекту. Оклад конкретного человека в этот круг не входит:
 * его видят только администратор и руководитель экономического отдела — тот же круг,
 * который вправе оклад и вносить.
 *
 * Редактирование собрано в одном месте намеренно. Величина уходит наружу четырьмя путями
 * (список закреплений, карточка объекта, ответ PATCH и снимки before/after в журнале),
 * и маскирование «по месту» рано или поздно разошлось бы с одним из них. В БД хранится
 * полное значение — правится только выдача.
 */

interface SalaryViewer {
  is_admin?: boolean;
  employee_id?: number | null;
}

export async function canSeeManagerSalary(user: SalaryViewer): Promise<boolean> {
  if (user.is_admin === true) return true;
  return isEconomicsHead(user.employee_id ?? null);
}

/** Строка закрепления в том виде, в каком её отдаёт API. */
interface SalaryBearing {
  salary_amount?: string | null;
}

export function redactAssignmentSalary<T extends SalaryBearing>(row: T, canSee: boolean): T;
export function redactAssignmentSalary<T extends SalaryBearing>(rows: T[], canSee: boolean): T[];
export function redactAssignmentSalary<T extends SalaryBearing>(
  input: T | T[],
  canSee: boolean,
): T | T[] {
  if (canSee) return input;
  return Array.isArray(input)
    ? input.map((row) => ({ ...row, salary_amount: null }))
    : { ...input, salary_amount: null };
}

/**
 * Журнал изменений. У закреплений из обоих снимков убирается сам ключ salary_amount и
 * вычищается имя поля из changed_fields: оставленное имя не показывает суммы, но выдаёт
 * факт и момент изменения оклада конкретного человека. Записи других сущностей не трогаются.
 */
export function redactHistorySalary(
  rows: ObjectKpiHistoryRow[],
  canSee: boolean,
): ObjectKpiHistoryRow[] {
  if (canSee) return rows;
  return rows.map((row) => {
    if (row.entity_kind !== 'assignment') return row;
    return {
      ...row,
      changed_fields: (row.changed_fields ?? []).filter((field) => field !== 'salary_amount'),
      before_data: withoutSalary(row.before_data),
      after_data: withoutSalary(row.after_data),
    };
  });
}

function withoutSalary(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot || !('salary_amount' in snapshot)) return snapshot;
  const { salary_amount: _salary, ...rest } = snapshot;
  return rest;
}
