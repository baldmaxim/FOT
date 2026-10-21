/**
 * «Общежитие» (миграция 314): кто из сотрудников живёт в общежитии — въезд, выезд, адрес или номер.
 *
 * Ведётся во вкладке «Управления кадрами», только чтение — в «Зарплате» («Справочник» → кнопка
 * «Общежитие»). Строка — одно проживание; периоды одного сотрудника не пересекаются
 * (EXCLUDE в БД, диапазон [въезд, выезд)). Отдел и должность — текущие, как в списке кадров.
 * Адрес добавленного или исправленного проживания запоминается в dormitory_addresses (миграция 319) — подсказки
 * поля «Адрес / номер»; удаление проживания адрес не трогает.
 */
import type { PoolClient } from 'pg';

import { getContractorRootId } from '../config/contractor.js';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { escapeLike } from '../utils/search.utils.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';
import { payrollContractorDeptsCte } from './payroll/payroll-registry-scope.service.js';

/** Нарушение EXCLUDE: у сотрудника уже есть проживание в эти даты. */
const PG_EXCLUSION_VIOLATION = '23P01';

export interface IDormitoryStay {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; живёт — null. */
  check_out: string | null;
  address: string;
}

export interface IDormitoryCandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
}

export interface IDormitoryStayInput {
  check_in: string;
  check_out: string | null;
  address: string;
}

/** Сотрудник для проверки перед записью: работает ли, не в архиве, не подрядчик. */
export interface IDormitoryEmployeeState {
  id: number;
  employment_status: string | null;
  is_archived: boolean;
  is_contractor: boolean;
}

const STAY_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
         to_char(s.check_out, 'YYYY-MM-DD') AS check_out,
         s.address
    FROM employee_dormitory_stays s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/**
 * Проживания в порядке ФИО и въезда. employeeIds / departmentIds — охват (null — без ограничения);
 * пустой массив — пустой ответ без запроса.
 */
export const listStays = async (scope: {
  employeeIds?: number[] | null;
  departmentIds?: string[] | null;
}): Promise<IDormitoryStay[]> => {
  const employeeIds = scope.employeeIds ?? null;
  const departmentIds = scope.departmentIds ?? null;
  if (employeeIds?.length === 0 || departmentIds?.length === 0) return [];
  return query<IDormitoryStay>(
    `${STAY_SELECT}
      WHERE ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
        AND ($2::uuid[] IS NULL OR e.org_department_id = ANY($2::uuid[]))
      ORDER BY e.full_name, s.check_in, s.id`,
    [employeeIds, departmentIds],
  );
};

export const getStay = async (id: number): Promise<IDormitoryStay | null> =>
  queryOne<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1`, [id]);

/** Строка внутри транзакции; lock — FOR UPDATE: правка и удаление видят одно «было». */
const readStay = async (client: PoolClient, id: number, lock: boolean): Promise<IDormitoryStay | null> =>
  (await client.query<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/**
 * Кого можно добавить: работающие, не в архиве, не из ветки подрядных организаций, по части ФИО;
 * employeeIds — охват (null — все).
 */
export const searchCandidates = async (
  search: string,
  employeeIds: number[] | null,
): Promise<IDormitoryCandidate[]> => {
  if (employeeIds?.length === 0) return [];
  return query<IDormitoryCandidate>(
    `WITH ${payrollContractorDeptsCte('$3')}
     SELECT e.id, e.full_name, d.name AS department, p.name AS position
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.full_name ILIKE $1
        AND e.employment_status = 'active'
        AND e.is_archived IS NOT TRUE
        AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = e.org_department_id)
        AND ($2::int[] IS NULL OR e.id = ANY($2::int[]))
      ORDER BY e.full_name
      LIMIT 20`,
    [`%${escapeLike(search)}%`, employeeIds, await getContractorRootId()],
  );
};

export const getEmployeeState = async (employeeId: number): Promise<IDormitoryEmployeeState | null> =>
  queryOne<IDormitoryEmployeeState>(
    `WITH ${payrollContractorDeptsCte('$2')}
     SELECT e.id, e.employment_status, (e.is_archived IS TRUE) AS is_archived,
            EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = e.org_department_id) AS is_contractor
       FROM employees e
      WHERE e.id = $1`,
    [employeeId, await getContractorRootId()],
  );

/** Запомнить адрес для подсказок; такой уже есть (без учёта регистра) — остаётся прежнее написание. */
const REMEMBER_ADDRESS_SQL = `INSERT INTO dormitory_addresses (address) VALUES ($1) ON CONFLICT DO NOTHING`;

/** Сохранённые адреса — подсказки поля «Адрес / номер», в порядке добавления. */
export const listAddresses = async (): Promise<string[]> =>
  (await query<{ address: string }>(`SELECT address FROM dormitory_addresses ORDER BY id`)).map(row => row.address);

/**
 * Добавить проживание и запомнить его адрес — одним запросом: пересечение с другим проживанием
 * сотрудника ('overlap') отменяет и адрес.
 */
export const addStay = async (
  employeeId: number,
  input: IDormitoryStayInput,
): Promise<IDormitoryStay | 'overlap'> => {
  try {
    const row = await queryOne<{ id: number }>(
      `WITH stay AS (
         INSERT INTO employee_dormitory_stays (employee_id, check_in, check_out, address)
         VALUES ($1, $2::date, $3::date, $4) RETURNING id
       ), remembered AS (
         INSERT INTO dormitory_addresses (address) VALUES ($4) ON CONFLICT DO NOTHING
       )
       SELECT id FROM stay`,
      [employeeId, input.check_in, input.check_out, input.address],
    );
    const stay = row ? await getStay(row.id) : null;
    if (!stay) throw new Error('Проживание не найдено после добавления');
    return stay;
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/**
 * Изменить даты и адрес. Проживания нет — null; пересечение — 'overlap'.
 * Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateStay = async (
  id: number,
  input: IDormitoryStayInput,
): Promise<{ before: IDormitoryStay; after: IDormitoryStay } | 'overlap' | null> => {
  try {
    return await withTransaction(async client => {
      const before = await readStay(client, id, true);
      if (!before) return null;
      await client.query(
        `UPDATE employee_dormitory_stays
            SET check_in = $2::date, check_out = $3::date, address = $4, updated_at = now()
          WHERE id = $1`,
        [id, input.check_in, input.check_out, input.address],
      );
      await client.query(REMEMBER_ADDRESS_SQL, [input.address]);
      const after = await readStay(client, id, false);
      return after ? { before, after } : null;
    });
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/** Удалить проживание (адрес в подсказках остаётся); его нет — null. */
export const deleteStay = async (id: number): Promise<IDormitoryStay | null> =>
  withTransaction(async client => {
    const before = await readStay(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM employee_dormitory_stays WHERE id = $1`, [id]);
    return before;
  });
