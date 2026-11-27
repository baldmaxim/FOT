/**
 * Удержания сотрудников (миграции 318, 321, 383): вид, подвид (необязателен), месяц удержания, сумма; у вида с
 * признаком requires_place_date — объект, уточнение и дата нарушения (staff-deduction-violation.ts).
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
import { resolveViolationFields, type IStaffDeductionViolation } from './staff-deduction-violation.js';

export interface IStaffDeduction extends IStaffDeductionViolation {
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
  /** Название объекта нарушения; объекта нет — null. */
  violation_object_name: string | null;
}

export interface IStaffDeductionInput extends IStaffDeductionViolation {
  kind_id: number;
  /** null — без подвида. */
  subkind_id: number | null;
  /** YYYY-MM. */
  month: string;
  amount: number;
}

/**
 * Вида, подвида или объекта нарушения уже нет в справочнике (удалили в соседнем окне) либо подвид не этого вида — FK
 * при записи.
 */
export type StaffDeductionRefMissing = 'kind_missing' | 'subkind_missing' | 'object_missing';

/** Почему удержание не записано: ссылки нет или у вида с признаком не указаны объект и дата нарушения. */
export type StaffDeductionWriteRefusal = StaffDeductionRefMissing | 'place_required';

const SUBKIND_FK = 'staff_deductions_subkind_fk';
const OBJECT_FK = 'staff_deductions_violation_object_fk';

/** Нарушение FK при записи — какой ссылки нет; не FK — null. */
const refMissing = (err: unknown): StaffDeductionRefMissing | null => {
  if (!hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return null;
  const constraint = pgConstraintName(err);
  if (constraint === SUBKIND_FK) return 'subkind_missing';
  return constraint === OBJECT_FK ? 'object_missing' : 'kind_missing';
};

/** Признак вида «нужны место и дата»; вида нет — null. */
const readKindRequiresPlaceDate = async (client: PoolClient, kindId: number): Promise<boolean | null> => {
  const row = (await client.query<{ requires_place_date: boolean }>(
    'SELECT requires_place_date FROM payroll_deduction_kinds WHERE id = $1',
    [kindId],
  )).rows[0];
  return row ? row.requires_place_date : null;
};

const DEDUCTION_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         s.kind_id, k.name AS kind_name,
         s.subkind_id, sk.name AS subkind_name,
         to_char(s.month, 'YYYY-MM') AS month,
         s.amount::text AS amount,
         s.violation_object_id::text AS violation_object_id, vo.name AS violation_object_name,
         s.violation_place, to_char(s.violation_date, 'YYYY-MM-DD') AS violation_date
    FROM staff_deductions s
    JOIN employees e ON e.id = s.employee_id
    JOIN payroll_deduction_kinds k ON k.id = s.kind_id
    LEFT JOIN payroll_deduction_subkinds sk ON sk.id = s.subkind_id
    LEFT JOIN skud_objects vo ON vo.id = s.violation_object_id
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

/**
 * Добавить удержание. Вида, подвида (не этого вида) или объекта нет — 'kind_missing' / 'subkind_missing' /
 * 'object_missing'; у вида с признаком нет объекта или даты нарушения — 'place_required'.
 */
export const addDeduction = async (
  employeeId: number,
  input: IStaffDeductionInput,
): Promise<IStaffDeduction | StaffDeductionWriteRefusal> => {
  try {
    return await withTransaction(async client => {
      const requiresPlaceDate = await readKindRequiresPlaceDate(client, input.kind_id);
      if (requiresPlaceDate === null) return 'kind_missing';
      const violation = resolveViolationFields(requiresPlaceDate, input.kind_id, input);
      if (violation === 'place_required') return violation;
      const row = (await client.query<{ id: number }>(
        `INSERT INTO staff_deductions
           (employee_id, kind_id, subkind_id, month, amount, violation_object_id, violation_place, violation_date)
         VALUES ($1, $2, $3, $4::date, $5, $6::uuid, $7, $8::date) RETURNING id`,
        [
          employeeId, input.kind_id, input.subkind_id, `${input.month}-01`, input.amount,
          violation.violation_object_id, violation.violation_place, violation.violation_date,
        ],
      )).rows[0];
      const deduction = row ? await readDeduction(client, row.id, false) : null;
      if (!deduction) throw new Error('Удержание не найдено после добавления');
      return deduction;
    });
  } catch (err) {
    const missing = refMissing(err);
    if (missing) return missing;
    throw err;
  }
};

/**
 * Изменить вид, подвид, месяц, сумму и место нарушения. Удержания нет — null; отказ — как у addDeduction (прежняя
 * строка вида без места и даты правится, не заполняя их). Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateDeduction = async (
  id: number,
  input: IStaffDeductionInput,
): Promise<{ before: IStaffDeduction; after: IStaffDeduction } | StaffDeductionWriteRefusal | null> => {
  try {
    return await withTransaction(async client => {
      const before = await readDeduction(client, id, true);
      if (!before) return null;
      const requiresPlaceDate = await readKindRequiresPlaceDate(client, input.kind_id);
      if (requiresPlaceDate === null) return 'kind_missing';
      const violation = resolveViolationFields(requiresPlaceDate, input.kind_id, input, before);
      if (violation === 'place_required') return violation;
      await client.query(
        `UPDATE staff_deductions
            SET kind_id = $2, subkind_id = $3, month = $4::date, amount = $5,
                violation_object_id = $6::uuid, violation_place = $7, violation_date = $8::date, updated_at = now()
          WHERE id = $1`,
        [
          id, input.kind_id, input.subkind_id, `${input.month}-01`, input.amount,
          violation.violation_object_id, violation.violation_place, violation.violation_date,
        ],
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

/** Объекты для «Места» нарушения: действующие, по названию. */
export const listViolationObjects = async (): Promise<Array<{ id: string; name: string }>> =>
  query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM skud_objects WHERE is_active = true ORDER BY name, id`,
  );

/** Удалить удержание; его нет — null. */
export const deleteDeduction = async (id: number): Promise<IStaffDeduction | null> =>
  withTransaction(async client => {
    const before = await readDeduction(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM staff_deductions WHERE id = $1`, [id]);
    return before;
  });
