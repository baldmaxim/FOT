/**
 * Удержания сотрудников (миграции 318, 321): вид, подвид (необязателен), месяц удержания, сумма.
 *
 * Строка — одно удержание; повторное того же вида в том же месяце — новая строка. Одни и те же записи ведут
 * кадры («Управление кадрами» → «Удержания») и «Зарплата» («Справочник» → «Удержания»); окно сотрудника на
 * «Расчётах» их показывает. Вид и подвид — из общего справочника (payroll_deduction_kinds/_subkinds); подвид
 * чужого вида не даёт записать составной FK. Отдел и должность — текущие, как в списке кадров.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../config/postgres.js';
import { hasPgCode, PG_FOREIGN_KEY_VIOLATION, pgConstraintName } from './payroll/payroll-pg-errors.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll/payroll-registry-scope.service.js';
import { termsPeriodParams, type PayrollTermsPeriod } from './payroll/payroll-terms-amount.service.js';

export interface IStaffDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  /** Подвид вида; без подвида — null. */
  subkind_id: number | null;
  subkind_name: string | null;
  /** YYYY-MM. */
  month: string;
  /** NUMERIC как строка: «5000.00». */
  amount: string;
}

export interface IStaffDeductionInput {
  kind_id: number;
  /** null — без подвида. */
  subkind_id: number | null;
  /** YYYY-MM. */
  month: string;
  amount: number;
}

/**
 * Вида или подвида уже нет в справочнике (удалили в соседнем окне) либо подвид не этого вида — FK при записи.
 */
export type StaffDeductionRefMissing = 'kind_missing' | 'subkind_missing';

const SUBKIND_FK = 'staff_deductions_subkind_fk';

/** Нарушение FK при записи — какой ссылки нет; не FK — null. */
const refMissing = (err: unknown): StaffDeductionRefMissing | null => {
  if (!hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return null;
  return pgConstraintName(err) === SUBKIND_FK ? 'subkind_missing' : 'kind_missing';
};

const DEDUCTION_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         s.kind_id, k.name AS kind_name,
         s.subkind_id, sk.name AS subkind_name,
         to_char(s.month, 'YYYY-MM') AS month,
         s.amount::text AS amount
    FROM staff_deductions s
    JOIN employees e ON e.id = s.employee_id
    JOIN payroll_deduction_kinds k ON k.id = s.kind_id
    LEFT JOIN payroll_deduction_subkinds sk ON sk.id = s.subkind_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/** Удержания в порядке ФИО и месяца. employeeIds — охват (null — без ограничения); пустой — пустой ответ. */
export const listDeductions = async (scope: { employeeIds: number[] | null }): Promise<IStaffDeduction[]> => {
  if (scope.employeeIds?.length === 0) return [];
  return query<IStaffDeduction>(
    `${DEDUCTION_SELECT}
      WHERE ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
      ORDER BY e.full_name, s.month, s.id`,
    [scope.employeeIds],
  );
};

/**
 * Удержания «штата зарплаты» — таблица «Удержания» окна «Справочник» на «Расчётах»: работающие, не подрядчики,
 * в охвате (departmentIds null — весь штат, пустой — пустой ответ). Период: на дату — удержания её месяца,
 * месяцы — удержания этих месяцев, оба NULL — все. Порядок — ФИО, месяц.
 */
export const listPayrollDeductions = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
  period: PayrollTermsPeriod;
}): Promise<IStaffDeduction[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IStaffDeduction>(
    `WITH ${payrollContractorDeptsCte('$1')}
     ${DEDUCTION_SELECT}
      WHERE ${payrollStaffWhereSql('e', '$2')}
        AND CASE WHEN $3::date IS NOT NULL THEN s.month = date_trunc('month', $3::date)::date
                 ELSE $4::date[] IS NULL OR s.month = ANY($4::date[])
            END
      ORDER BY e.full_name, e.id, s.month, s.id`,
    [scope.contractorRootId, scope.departmentIds, ...termsPeriodParams(scope.period)],
  );
};

export const getDeduction = async (id: number): Promise<IStaffDeduction | null> =>
  queryOne<IStaffDeduction>(`${DEDUCTION_SELECT} WHERE s.id = $1`, [id]);

/** Строка внутри транзакции; lock — FOR UPDATE: правка и удаление видят одно «было». */
const readDeduction = async (client: PoolClient, id: number, lock: boolean): Promise<IStaffDeduction | null> =>
  (await client.query<IStaffDeduction>(`${DEDUCTION_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/** Добавить удержание; вида или подвида нет (подвид не этого вида) — 'kind_missing' / 'subkind_missing'. */
export const addDeduction = async (
  employeeId: number,
  input: IStaffDeductionInput,
): Promise<IStaffDeduction | StaffDeductionRefMissing> => {
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO staff_deductions (employee_id, kind_id, subkind_id, month, amount)
       VALUES ($1, $2, $3, $4::date, $5) RETURNING id`,
      [employeeId, input.kind_id, input.subkind_id, `${input.month}-01`, input.amount],
    );
    const deduction = row ? await getDeduction(row.id) : null;
    if (!deduction) throw new Error('Удержание не найдено после добавления');
    return deduction;
  } catch (err) {
    const missing = refMissing(err);
    if (missing) return missing;
    throw err;
  }
};

/**
 * Изменить вид, подвид, месяц и сумму. Удержания нет — null; вида или подвида нет — 'kind_missing' /
 * 'subkind_missing'. Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateDeduction = async (
  id: number,
  input: IStaffDeductionInput,
): Promise<{ before: IStaffDeduction; after: IStaffDeduction } | StaffDeductionRefMissing | null> => {
  try {
    return await withTransaction(async client => {
      const before = await readDeduction(client, id, true);
      if (!before) return null;
      await client.query(
        `UPDATE staff_deductions
            SET kind_id = $2, subkind_id = $3, month = $4::date, amount = $5, updated_at = now()
          WHERE id = $1`,
        [id, input.kind_id, input.subkind_id, `${input.month}-01`, input.amount],
      );
      const after = await readDeduction(client, id, false);
      return after ? { before, after } : null;
    });
  } catch (err) {
    const missing = refMissing(err);
    if (missing) return missing;
    throw err;
  }
};

/** Удалить удержание; его нет — null. */
export const deleteDeduction = async (id: number): Promise<IStaffDeduction | null> =>
  withTransaction(async client => {
    const before = await readDeduction(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM staff_deductions WHERE id = $1`, [id]);
    return before;
  });
