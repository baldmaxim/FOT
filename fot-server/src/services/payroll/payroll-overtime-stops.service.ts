/**
 * «Без переработки» — таблица окна «Справочник» на «Расчётах» (миграция 335): кому не оплачивать
 * переработку, период «с — по» (по — включительно, NULL — бессрочно). Расчёт — payroll-calc.rules.ts.
 *
 * Возобновили оплату — ставят «по», строка остаётся историей; удаляют только ошибочную. Периоды
 * одного сотрудника не пересекаются (EXCLUDE в БД). Отдел и должность — текущие.
 */
import type { PoolClient } from 'pg';

import { query, queryOne, withTransaction } from '../../config/postgres.js';
import { hasPgCode } from './payroll-pg-errors.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';

/** Нарушение EXCLUDE: у сотрудника уже есть период в эти даты. */
const PG_EXCLUSION_VIOLATION = '23P01';

export interface IOvertimeStop {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** YYYY-MM-DD. */
  date_from: string;
  /** YYYY-MM-DD; бессрочно — null. */
  date_to: string | null;
}

export interface IOvertimeStopInput {
  date_from: string;
  date_to: string | null;
}

const STOP_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         to_char(s.date_from, 'YYYY-MM-DD') AS date_from,
         to_char(s.date_to, 'YYYY-MM-DD') AS date_to
    FROM payroll_overtime_stops s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/** Все периоды (история) «штата зарплаты» в порядке ФИО и даты начала. */
export const listOvertimeStops = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
}): Promise<IOvertimeStop[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IOvertimeStop>(
    `WITH ${payrollContractorDeptsCte('$1')}
     ${STOP_SELECT}
      WHERE ${payrollStaffWhereSql('e', '$2')}
      ORDER BY e.full_name, s.employee_id, s.date_from, s.id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

export const getOvertimeStop = async (id: number): Promise<IOvertimeStop | null> =>
  queryOne<IOvertimeStop>(`${STOP_SELECT} WHERE s.id = $1`, [id]);

const readStop = async (client: PoolClient, id: number, lock: boolean): Promise<IOvertimeStop | null> =>
  (await client.query<IOvertimeStop>(`${STOP_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/** Добавить период; пересекается с другим периодом сотрудника — 'overlap'. */
export const addOvertimeStop = async (
  employeeId: number,
  input: IOvertimeStopInput,
): Promise<IOvertimeStop | 'overlap'> => {
  try {
    const row = await queryOne<{ id: number }>(
      `INSERT INTO payroll_overtime_stops (employee_id, date_from, date_to)
       VALUES ($1, $2::date, $3::date) RETURNING id`,
      [employeeId, input.date_from, input.date_to],
    );
    const stop = row ? await getOvertimeStop(row.id) : null;
    if (!stop) throw new Error('Период не найден после добавления');
    return stop;
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/** Изменить даты; периода нет — null, пересечение — 'overlap'. Возвращает «было → стало» для аудита. */
export const updateOvertimeStop = async (
  id: number,
  input: IOvertimeStopInput,
): Promise<{ before: IOvertimeStop; after: IOvertimeStop } | 'overlap' | null> => {
  try {
    return await withTransaction(async client => {
      const before = await readStop(client, id, true);
      if (!before) return null;
      await client.query(
        `UPDATE payroll_overtime_stops
            SET date_from = $2::date, date_to = $3::date, updated_at = now()
          WHERE id = $1`,
        [id, input.date_from, input.date_to],
      );
      const after = await readStop(client, id, false);
      return after ? { before, after } : null;
    });
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/** Удалить ошибочный период; его нет — null. */
export const deleteOvertimeStop = async (id: number): Promise<IOvertimeStop | null> =>
  withTransaction(async client => {
    const before = await readStop(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM payroll_overtime_stops WHERE id = $1`, [id]);
    return before;
  });
