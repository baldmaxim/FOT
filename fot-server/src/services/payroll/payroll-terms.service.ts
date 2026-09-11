/**
 * Условия оплаты сотрудника: категория персонала и вид оплаты («по графику» / «по часам»).
 *
 * Историчность вместо перезаписи. Смена условий — это закрытие текущей строки
 * (effective_to = D-1) и вставка новой с effective_from = D, одной транзакцией.
 * Прошлые расчёты ссылаются на конкретный terms_id и не переигрываются.
 * Пересечение периодов физически невозможно: EXCLUDE в БД (миграция 271).
 *
 * Неполная занятость выражается ОДНИМ механизмом — личным графиком работы.
 * Поэтому staff_units здесь справочный и в расчёте не участвует: иначе половина
 * ставки применилась бы дважды (график «0,5 ставки» уже даёт 4 ч вместо 8).
 */
import { query, queryOne, withTransaction, type DbExecutor } from '../../config/postgres.js';

/** Категория персонала. Задаёт calc_type по умолчанию; на формулу расчёта не влияет. */
export type StaffCategory = 'office' | 'itr' | 'worker';
/** Вид оплаты. Единственное, что определяет формулу начисления. */
export type PayrollCalcType = 'salary' | 'hourly';

export interface IPayrollTerms {
  id: number;
  employee_id: number;
  organization_id: string | null;
  staff_category: StaffCategory;
  calc_type: PayrollCalcType;
  monthly_salary: number | null;
  hourly_rate: number | null;
  staff_units: number;
  time_accounting_mode: 'daily' | 'summarized';
  accounting_period_months: number | null;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IAssignTermsInput {
  employeeId: number;
  staffCategory: StaffCategory;
  calcType: PayrollCalcType;
  /** Оклад — только для calc_type='salary'. */
  monthlySalary?: number | null;
  /** Часовая ставка — только для calc_type='hourly'. */
  hourlyRate?: number | null;
  staffUnits?: number;
  organizationId?: string | null;
  effectiveFrom: string;
  changeReason?: string | null;
  orderNumber?: string | null;
  orderDate?: string | null;
  note?: string | null;
  createdBy: string;
}

/** Причина, по которой сотрудник не получил условия при массовом назначении. */
export type AssignSkipReason = 'NO_ACCESS' | 'OVERLAPS_EXISTING';

export interface IAssignResult {
  applied: Array<{ employee_id: number; terms_id: number }>;
  skipped: Array<{ employee_id: number; reason: AssignSkipReason; message: string }>;
}

/** SQLSTATE 23P01 — нарушение EXCLUDE (пересечение периодов условий). */
const EXCLUSION_VIOLATION = '23P01';

const TERMS_COLUMNS = `
  id, employee_id, organization_id, staff_category, calc_type,
  monthly_salary, hourly_rate, staff_units,
  time_accounting_mode, accounting_period_months,
  effective_from, effective_to,
  change_reason, order_number, order_date, note,
  created_by, created_at, updated_at`;

/** Вид оплаты по умолчанию для категории. Офис — оклад, стройка — часы. */
export const defaultCalcTypeFor = (category: StaffCategory): PayrollCalcType =>
  (category === 'office' ? 'salary' : 'hourly');

/** Полная история условий сотрудника, новые сверху. */
export const getTermsHistory = async (employeeId: number): Promise<IPayrollTerms[]> =>
  query<IPayrollTerms>(
    `SELECT ${TERMS_COLUMNS}
       FROM payroll_compensation_terms
      WHERE employee_id = $1
      ORDER BY effective_from DESC, id DESC`,
    [employeeId],
  );

/** Условия, действующие на дату. null — условий на эту дату нет. */
export const getTermsOnDate = async (
  employeeId: number,
  date: string,
  exec?: DbExecutor,
): Promise<IPayrollTerms | null> => {
  const sql = `SELECT ${TERMS_COLUMNS}
                 FROM payroll_compensation_terms
                WHERE employee_id = $1
                  AND effective_from <= $2::date
                  AND (effective_to IS NULL OR effective_to >= $2::date)
                LIMIT 1`;
  if (exec) {
    const res = await exec.query<IPayrollTerms>(sql, [employeeId, date]);
    return res.rows[0] ?? null;
  }
  return queryOne<IPayrollTerms>(sql, [employeeId, date]);
};

/**
 * Все условия, пересекающиеся с периодом, по возрастанию даты начала.
 * Именно отсюда расчёт получит сегменты: перевод «оклад → часы» 16-го числа
 * даёт две строки, и период режется по их границам.
 */
export const getTermsForPeriod = async (
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, IPayrollTerms[]>> => {
  const result = new Map<number, IPayrollTerms[]>();
  if (employeeIds.length === 0) return result;

  const rows = await query<IPayrollTerms>(
    `SELECT ${TERMS_COLUMNS}
       FROM payroll_compensation_terms
      WHERE employee_id = ANY($1::int[])
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY employee_id, effective_from`,
    [employeeIds, startDate, endDate],
  );

  for (const row of rows) {
    const list = result.get(row.employee_id);
    if (list) list.push(row);
    else result.set(row.employee_id, [row]);
  }
  return result;
};

/** Сотрудники без условий оплаты на дату — их нельзя молча пропустить в расчёте. */
export const findEmployeesWithoutTerms = async (
  employeeIds: number[],
  date: string,
): Promise<number[]> => {
  if (employeeIds.length === 0) return [];
  const rows = await query<{ employee_id: number }>(
    `SELECT e.id AS employee_id
       FROM unnest($1::int[]) AS e(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM payroll_compensation_terms t
         WHERE t.employee_id = e.id
           AND t.effective_from <= $2::date
           AND (t.effective_to IS NULL OR t.effective_to >= $2::date))`,
    [employeeIds, date],
  );
  return rows.map(r => r.employee_id);
};

/**
 * Назначить условия одному сотруднику: закрыть действующие и открыть новые.
 *
 * Обе операции в одной транзакции — иначе при сбое между ними сотрудник остался бы
 * либо без условий, либо с двумя открытыми строками.
 */
export const assignTerms = async (
  input: IAssignTermsInput,
  exec?: DbExecutor,
): Promise<number> => {
  const run = async (client: DbExecutor): Promise<number> => {
    // Закрываем действующие на дату условия.
    await client.query(
      `UPDATE payroll_compensation_terms
          SET effective_to = ($2::date - INTERVAL '1 day')::date,
              updated_at = now()
        WHERE employee_id = $1
          AND effective_from < $2::date
          AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [input.employeeId, input.effectiveFrom],
    );
    // Условия, начинающиеся в эту дату или позже, заменяются: назначение задним
    // числом не должно оставлять «хвост» из более поздних строк.
    await client.query(
      `DELETE FROM payroll_compensation_terms
        WHERE employee_id = $1 AND effective_from >= $2::date`,
      [input.employeeId, input.effectiveFrom],
    );

    const inserted = await client.query<{ id: number }>(
      `INSERT INTO payroll_compensation_terms
         (employee_id, organization_id, staff_category, calc_type,
          monthly_salary, hourly_rate, staff_units,
          effective_from, change_reason, order_number, order_date, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 1.000), $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        input.employeeId,
        input.organizationId ?? null,
        input.staffCategory,
        input.calcType,
        input.calcType === 'salary' ? input.monthlySalary ?? null : null,
        input.calcType === 'hourly' ? input.hourlyRate ?? null : null,
        input.staffUnits ?? null,
        input.effectiveFrom,
        input.changeReason ?? null,
        input.orderNumber ?? null,
        input.orderDate ?? null,
        input.note ?? null,
        input.createdBy,
      ],
    );
    return inserted.rows[0].id;
  };

  return exec ? run(exec) : withTransaction(run);
};

/** SQLSTATE ошибки pg. */
const sqlStateOf = (err: unknown): string | null => (
  typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code ?? '')
    : null
);

/**
 * Массовое назначение с общей датой вступления в силу.
 *
 * Каждый сотрудник — в своей транзакции: сбой на одном не отменяет всю пачку.
 * Отклонённые возвращаются списком с причиной, а не пропадают молча.
 */
export const assignTermsBulk = async (
  employeeIds: number[],
  input: Omit<IAssignTermsInput, 'employeeId'>,
): Promise<IAssignResult> => {
  const applied: IAssignResult['applied'] = [];
  const skipped: IAssignResult['skipped'] = [];

  for (const employeeId of employeeIds) {
    try {
      const termsId = await assignTerms({ ...input, employeeId });
      applied.push({ employee_id: employeeId, terms_id: termsId });
    } catch (err) {
      if (sqlStateOf(err) === EXCLUSION_VIOLATION) {
        skipped.push({
          employee_id: employeeId,
          reason: 'OVERLAPS_EXISTING',
          message: 'Условия на эту дату пересекаются с существующими',
        });
        continue;
      }
      throw err;
    }
  }

  return { applied, skipped };
};
