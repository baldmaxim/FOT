/**
 * «Проживание» (миграции 314, 320): где живёт сотрудник — въезд, выезд и вид:
 * - общежитие компании (dormitory) — адрес или номер обязателен;
 * - квартира (apartment) — сумма доплаты за проживание ₽/мес, адрес необязателен.
 *
 * Ведётся во вкладке «Управления кадрами»; квартиры — те же записи, что «Доплата за проживание» «Зарплаты»
 * (её таблица пишет сюда же), общежития «Зарплата» видит только для чтения («Справочник» → «Общежитие»).
 * Строка — одно проживание; периоды одного сотрудника не пересекаются ни в каком виде (EXCLUDE в БД,
 * диапазон [въезд, выезд)). Отдел и должность — текущие, как в списке кадров.
 * Запись — под lockPayrollEmployee (тот же замок, что у доплат «Зарплаты»): квартира в днях «Доплаты за
 * общежитие» — DormitoryAllowanceConflictError (одна доплата из двух).
 * Адрес общежития запоминается в dormitory_addresses (миграция 319) — подсказки поля «Адрес / номер»;
 * удаление проживания адрес не трогает.
 */
import type { PoolClient } from 'pg';

import { getContractorRootId } from '../config/contractor.js';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { buildFioSearch, fioExactConditionSql, fioFuzzyConditionSql } from '../utils/fio-search.utils.js';
import { assertApartmentWithoutDormitoryAllowance } from './payroll/payroll-dormitory-allowances.service.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';
import { HOUSING_RATE_CODE } from './payroll/payroll-rates.service.js';
import { payrollContractorDeptsCte } from './payroll/payroll-registry-scope.service.js';
import { lockPayrollEmployee } from './payroll/payroll-terms.service.js';

/** Нарушение EXCLUDE: у сотрудника уже есть проживание в эти даты. */
const PG_EXCLUSION_VIOLATION = '23P01';

/** Общежитие компании или квартира (доплата за проживание). */
export type DormitoryStayKind = 'dormitory' | 'apartment';

export interface IDormitoryStay {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind: DormitoryStayKind;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; живёт — null. */
  check_out: string | null;
  /** У общежития — всегда; у квартиры — если указали. */
  address: string | null;
  /** Только у квартиры: ₽/мес, numeric строкой. */
  amount: string | null;
}

export interface IDormitoryCandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
}

/** Даты, адрес и сумма; вид задаётся при добавлении и при правке не меняется. */
export interface IDormitoryStayFields {
  check_in: string;
  check_out: string | null;
  address: string | null;
  /** Только у квартиры. */
  amount: number | null;
}

export interface IDormitoryStayInput extends IDormitoryStayFields {
  kind: DormitoryStayKind;
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
         s.kind,
         to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
         to_char(s.check_out, 'YYYY-MM-DD') AS check_out,
         s.address,
         s.amount::text AS amount
    FROM employee_dormitory_stays s
    JOIN employees e ON e.id = s.employee_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/**
 * Проживания в порядке ФИО и въезда. employeeIds / departmentIds — охват (null — без ограничения);
 * пустой массив — пустой ответ без запроса. kind — только этот вид («Справочник» → «Общежитие»).
 */
export const listStays = async (scope: {
  employeeIds?: number[] | null;
  departmentIds?: string[] | null;
  kind?: DormitoryStayKind;
}): Promise<IDormitoryStay[]> => {
  const employeeIds = scope.employeeIds ?? null;
  const departmentIds = scope.departmentIds ?? null;
  if (employeeIds?.length === 0 || departmentIds?.length === 0) return [];
  return query<IDormitoryStay>(
    `${STAY_SELECT}
      WHERE ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
        AND ($2::uuid[] IS NULL OR e.org_department_id = ANY($2::uuid[]))
        AND ($3::text IS NULL OR s.kind = $3)
      ORDER BY e.full_name, s.check_in, s.id`,
    [employeeIds, departmentIds, scope.kind ?? null],
  );
};

export const getStay = async (id: number): Promise<IDormitoryStay | null> =>
  queryOne<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1`, [id]);

/** Строка внутри транзакции; lock — FOR UPDATE: правка и удаление видят одно «было». */
const readStay = async (client: PoolClient, id: number, lock: boolean): Promise<IDormitoryStay | null> =>
  (await client.query<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/**
 * Кого можно добавить: работающие, не в архиве, не из ветки подрядных организаций, по части ФИО
 * (ё = е, английская раскладка; ничего точного — с одной ошибкой); employeeIds — охват (null — все).
 */
export const searchCandidates = async (
  search: string,
  employeeIds: number[] | null,
): Promise<IDormitoryCandidate[]> => {
  const fio = buildFioSearch(search);
  if (!fio || employeeIds?.length === 0) return [];
  const contractorRootId = await getContractorRootId();
  const find = (fuzzy: boolean) => {
    // Число параметров поиска зависит от ввода (латиница — два выражения), поэтому они — после постоянных.
    const params: unknown[] = [employeeIds, contractorRootId];
    const searchSql = fuzzy ? fioFuzzyConditionSql('e', params, fio) : fioExactConditionSql('e', params, fio);
    return query<IDormitoryCandidate>(
      `WITH ${payrollContractorDeptsCte('$2')}
       SELECT e.id, e.full_name, d.name AS department, p.name AS position
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE ${searchSql}
          AND e.employment_status = 'active'
          AND e.is_archived IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = e.org_department_id)
          AND ($1::int[] IS NULL OR e.id = ANY($1::int[]))
        ORDER BY e.full_name
        LIMIT 20`,
      params,
    );
  };
  const exact = await find(false);
  if (exact.length > 0 || fio.fuzzy.length === 0) return exact;
  return find(true);
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

/** Запомнить адрес общежития для подсказок; такой уже есть (без учёта регистра) — остаётся прежнее написание. */
const REMEMBER_ADDRESS_SQL = `INSERT INTO dormitory_addresses (address) VALUES ($1) ON CONFLICT DO NOTHING`;

/** Сохранённые адреса общежитий — подсказки поля «Адрес / номер», в порядке добавления. */
export const listAddresses = async (): Promise<string[]> =>
  (await query<{ address: string }>(`SELECT address FROM dormitory_addresses ORDER BY id`)).map(row => row.address);

/**
 * Сумма по умолчанию для квартиры — значение ставки «Доплата за проживание» (code housing) на текущий месяц
 * МСК (миграция 324); не задана — null.
 */
export const getHousingRateAmount = async (): Promise<string | null> =>
  (await queryOne<{ amount: string | null }>(
    `SELECT payroll_rate_value($1, $2::date)::text AS amount`,
    [HOUSING_RATE_CODE, moscowTodayIso()],
  ))?.amount ?? null;

/** После записи: адрес общежития — в подсказки; квартира — без доплаты за общежитие в добавленных днях. */
const afterWrite = async (
  client: PoolClient,
  stay: { employee_id: number; kind: DormitoryStayKind } & IDormitoryStayFields,
  previous: { check_in: string; check_out: string | null } | null,
): Promise<void> => {
  if (stay.kind === 'dormitory' && stay.address) {
    await client.query(REMEMBER_ADDRESS_SQL, [stay.address]);
  }
  if (stay.kind === 'apartment') {
    await assertApartmentWithoutDormitoryAllowance(client, stay.employee_id, stay, previous);
  }
};

/**
 * Добавить проживание. Пересечение с другим проживанием сотрудника — 'overlap'; квартира в днях доплаты
 * за общежитие — DormitoryAllowanceConflictError (запись откатывается).
 */
export const addStay = async (
  employeeId: number,
  input: IDormitoryStayInput,
): Promise<IDormitoryStay | 'overlap'> => {
  try {
    return await withTransaction(async client => {
      await lockPayrollEmployee(client, employeeId);
      const row = (await client.query<{ id: number }>(
        `INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address, amount)
         VALUES ($1, $2, $3::date, $4::date, $5, $6) RETURNING id`,
        [employeeId, input.kind, input.check_in, input.check_out, input.address, input.amount],
      )).rows[0];
      await afterWrite(client, { employee_id: employeeId, ...input }, null);
      const stay = await readStay(client, row.id, false);
      if (!stay) throw new Error('Проживание не найдено после добавления');
      return stay;
    });
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/**
 * Изменить даты, адрес и сумму (вид не меняется); amount null — сумма прежняя (кадры сумму квартиры не задают,
 * у общежития её нет). Проживания нет — null; пересечение — 'overlap'; квартира в добавленных днях доплаты
 * за общежитие — DormitoryAllowanceConflictError. Возвращает прежнюю и новую строки: аудит пишет «было → стало».
 */
export const updateStay = async (
  id: number,
  input: IDormitoryStayFields,
): Promise<{ before: IDormitoryStay; after: IDormitoryStay } | 'overlap' | null> => {
  try {
    return await withTransaction(async client => {
      const current = await readStay(client, id, false);
      if (!current) return null;
      // Замок сотрудника — до чтения под FOR UPDATE: тот же порядок, что у доплат «Зарплаты».
      await lockPayrollEmployee(client, current.employee_id);
      const before = await readStay(client, id, true);
      if (!before) return null;
      await client.query(
        `UPDATE employee_dormitory_stays
            SET check_in = $2::date, check_out = $3::date, address = $4, amount = COALESCE($5, amount),
                updated_at = now()
          WHERE id = $1`,
        [id, input.check_in, input.check_out, input.address, input.amount],
      );
      await afterWrite(client, { employee_id: before.employee_id, kind: before.kind, ...input }, before);
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
