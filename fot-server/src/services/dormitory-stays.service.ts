/**
 * «Проживание» (миграции 314, 320): где живёт сотрудник — въезд, выезд и вид:
 * - общежитие компании (dormitory) — адрес или номер обязателен;
 * - квартира (apartment) — сумма доплаты за проживание ₽/мес, адрес необязателен.
 *
 * Ведётся во вкладке «Управления кадрами»; квартиры — те же записи, что «Доплата за проживание» «Зарплаты»
 * (её таблица пишет сюда же), общежития «Зарплата» только убирает («Справочник» → «Общежитие», 🗑).
 * Строка — одно проживание; периоды одного сотрудника не пересекаются ни в каком виде (EXCLUDE в БД,
 * диапазон [въезд, выезд)). Отдел и должность — текущие, как в списке кадров.
 * Запись — под lockPayrollEmployee (тот же замок, что у доплат «Зарплаты»): квартира в днях «Доплаты за
 * общежитие» — DormitoryAllowanceConflictError (одна доплата из двух).
 * Адрес общежития запоминается в dormitory_addresses (миграция 319) — подсказки поля «Адрес / номер»;
 * удаление проживания адрес не трогает.
 * Служебная квартира (миграция 371) — вид dormitory со ссылкой apartment_id; адрес проживания — копия «Кв. <адрес>»
 * квартиры (её меняет только правка квартиры, company-apartments.service.ts), в подсказки не попадает. Классы записей —
 * STAY_CLASS_SQL.
 */
import type { PoolClient } from 'pg';

import { getContractorRootId } from '../config/contractor.js';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { buildFioSearch, fioExactConditionSql, fioFuzzyConditionSql } from '../utils/fio-search.utils.js';
import { effectiveDepartmentSql } from './employees-export.service.js';
import { assertApartmentWithoutDormitoryAllowance } from './payroll/payroll-dormitory-allowances.service.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';
import { HOUSING_RATE_CODE } from './payroll/payroll-rates.service.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll/payroll-registry-scope.service.js';
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
  /** Только у квартиры (компенсации): ставка ₽/день, numeric строкой. */
  amount: string | null;
  /** Служебная квартира (миграция 371); общежитие и компенсация — null. */
  apartment_id: number | null;
  /** «Платно» — только у жильца служебной квартиры. */
  paid: boolean;
  comment: string | null;
  /** ISO-время последней правки записи. */
  updated_at: string;
  employment_status: string | null;
  /** YYYY-MM-DD; работает — null. */
  dismissal_date: string | null;
  /** Текущий отдел карточки (uuid) — для «Начальника участка». */
  org_department_id: string | null;
  /** Гражданство — employees.country (зеркало реквизитов). */
  country: string | null;
  /** Компенсация закрыта паузой, а не окончанием (миграция 374; до неё — false). */
  suspended: boolean;
  /** Компенсация возобновлена из этой приостановленной записи (миграция 374); нет — null. */
  resumed_from_id: number | null;
}

/**
 * Классы записей (миграция 371), одно правило во всех запросах: служебная квартира — общежитие со ссылкой на
 * квартиру, общежитие — без ссылки, компенсация аренды — вид apartment.
 */
export const STAY_CLASS_SQL = {
  flat: (alias: string) => `(${alias}.kind = 'dormitory' AND ${alias}.apartment_id IS NOT NULL)`,
  dormitory: (alias: string) => `(${alias}.kind = 'dormitory' AND ${alias}.apartment_id IS NULL)`,
  compensation: (alias: string) => `(${alias}.kind = 'apartment')`,
} as const;

/** «Живёт на дату» ([въезд, выезд)): одно правило для счётчиков, списков и истории. */
export const livesOnSql = (alias: string, dateParam: string): string => (
  `(${alias}.check_in <= ${dateParam}::date AND (${alias}.check_out IS NULL OR ${alias}.check_out > ${dateParam}::date))`
);

export interface IDormitoryCandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** YYYY-MM-DD; работающий — null. Уволенные — только в поиске с dismissedFrom (удержания). */
  dismissal_date: string | null;
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
  /** Жилец служебной квартиры (вид dormitory); адрес — копия «Кв. <адрес>», её подставляет контроллер. */
  apartment_id?: number | null;
}

/**
 * Сотрудник для проверки перед записью: работает ли, не в архиве, не подрядчик. Подрядчик — по отделу из
 * effectiveDepartmentSql: у уволенного это отдел, из которого уволен (карточка уже в «Уволенных»), у работающего —
 * отдел карточки.
 */
export interface IDormitoryEmployeeState {
  id: number;
  employment_status: string | null;
  is_archived: boolean;
  is_contractor: boolean;
  /** YYYY-MM-DD; нет — null. */
  dismissal_date: string | null;
}

const STAY_SELECT = `
  SELECT s.id, s.employee_id, e.full_name, d.name AS department, p.name AS position,
         s.kind,
         to_char(s.check_in, 'YYYY-MM-DD') AS check_in,
         to_char(s.check_out, 'YYYY-MM-DD') AS check_out,
         s.address,
         s.amount::text AS amount,
         s.apartment_id, s.paid, s.comment,
         to_char(s.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at,
         e.employment_status,
         to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date,
         e.org_department_id::text AS org_department_id,
         e.country,
         -- Колонки миграции 374 — через to_jsonb: бэкенд читает записи и до неё.
         COALESCE((to_jsonb(s) ->> 'suspended')::boolean, false) AS suspended,
         (to_jsonb(s) ->> 'resumed_from_id')::int AS resumed_from_id
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

/**
 * Проживания одного класса (STAY_CLASS_SQL) в охвате employeeIds (null — без ограничения, пустой — пустой ответ):
 * все, с историей; period — только задевающие [from, to] (въезд не позже to, выезд позже from). Порядок — ФИО, въезд.
 */
export const listStaysOfClass = async (
  stayClass: keyof typeof STAY_CLASS_SQL,
  employeeIds: number[] | null,
  period: { from: string; to: string } | null = null,
): Promise<IDormitoryStay[]> => {
  if (employeeIds?.length === 0) return [];
  return query<IDormitoryStay>(
    `${STAY_SELECT}
      WHERE ${STAY_CLASS_SQL[stayClass]('s')}
        AND ($1::int[] IS NULL OR s.employee_id = ANY($1::int[]))
        AND ($2::date IS NULL OR s.check_in <= $2::date)
        AND ($3::date IS NULL OR s.check_out IS NULL OR s.check_out > $3::date)
      ORDER BY e.full_name, e.id, s.check_in, s.id`,
    [employeeIds, period?.to ?? null, period?.from ?? null],
  );
};

/**
 * Общежития «штата зарплаты» — «Справочник» → «Общежитие»: работающие, не в архиве, не подрядчики, в охвате
 * (departmentIds null — весь штат, пустой — пустой ответ). Уволенных не видно, их записи остаются.
 */
export const listPayrollDormitoryStays = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
}): Promise<IDormitoryStay[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IDormitoryStay>(
    `WITH ${payrollContractorDeptsCte('$1')}
     ${STAY_SELECT}
      WHERE s.kind = 'dormitory'
        AND ${payrollStaffWhereSql('e', '$2')}
      ORDER BY e.full_name, e.id, s.check_in, s.id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

export const getStay = async (id: number): Promise<IDormitoryStay | null> =>
  queryOne<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1`, [id]);

/** Строка внутри транзакции; lock — FOR UPDATE: правка и удаление видят одно «было». */
export const readStay = async (client: PoolClient, id: number, lock: boolean): Promise<IDormitoryStay | null> =>
  (await client.query<IDormitoryStay>(`${STAY_SELECT} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`, [id]))
    .rows[0] ?? null;

/**
 * Кого можно добавить: работающие, не в архиве, не из ветки подрядных организаций, по части ФИО
 * (ё = е, английская раскладка; ничего точного — с одной ошибкой); employeeIds — охват (null — все).
 * dismissedFrom (YYYY-MM-DD) — ещё и уволенные с датой увольнения не раньше неё (удержания: до месяца
 * увольнения); подрядчик у них — по отделу, из которого уволены. Без него — только работающие («Проживание»).
 */
export const searchCandidates = async (
  search: string,
  employeeIds: number[] | null,
  options: { dismissedFrom?: string } = {},
): Promise<IDormitoryCandidate[]> => {
  const fio = buildFioSearch(search);
  if (!fio || employeeIds?.length === 0) return [];
  const contractorRootId = await getContractorRootId();
  const find = (fuzzy: boolean) => {
    // Число параметров поиска зависит от ввода (латиница — два выражения), поэтому они — после постоянных.
    const params: unknown[] = [employeeIds, contractorRootId, options.dismissedFrom ?? null];
    const searchSql = fuzzy ? fioFuzzyConditionSql('e', params, fio) : fioExactConditionSql('e', params, fio);
    return query<IDormitoryCandidate>(
      `WITH ${payrollContractorDeptsCte('$2')}
       SELECT e.id, e.full_name, d.name AS department, p.name AS position,
              to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE ${searchSql}
          AND (e.employment_status = 'active'
               OR ($3::date IS NOT NULL AND e.employment_status = 'fired' AND e.dismissal_date >= $3::date))
          AND e.is_archived IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = ${effectiveDepartmentSql('e')})
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
            EXISTS (SELECT 1 FROM contractor_depts c WHERE c.id = ${effectiveDepartmentSql('e')}) AS is_contractor,
            to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date
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

/**
 * После записи: адрес общежития — в подсказки (служебная квартира — нет: её адрес у квартиры); квартира — без доплаты
 * за общежитие в добавленных днях.
 */
const afterWrite = async (
  client: PoolClient,
  stay: { employee_id: number; kind: DormitoryStayKind; apartment_id?: number | null } & IDormitoryStayFields,
  previous: { check_in: string; check_out: string | null } | null,
): Promise<void> => {
  if (stay.kind === 'dormitory' && stay.address && !stay.apartment_id) {
    await client.query(REMEMBER_ADDRESS_SQL, [stay.address]);
  }
  if (stay.kind === 'apartment') {
    await assertApartmentWithoutDormitoryAllowance(client, stay.employee_id, stay, previous);
  }
};

/**
 * Компенсацию аренды сотрудника приостановили и не возобновили и не завершили: новую не заводят (иначе пропала бы
 * цепочка «пауза → возобновление», миграция 374) — ответ 409.
 */
export class CompensationPausedError extends Error {
  readonly code = 'COMPENSATION_PAUSED';

  constructor(pausedFrom: string) {
    const [year, month, day] = pausedFrom.split('-');
    super(`Компенсация приостановлена с ${day}.${month}.${year} — возобновите или завершите её`);
    this.name = 'CompensationPausedError';
  }
}

/** Приостановленная и не возобновлённая компенсация сотрудника: дата паузы; нет — null. Колонки 374 — через to_jsonb. */
export const openPauseOf = async (client: PoolClient, employeeId: number): Promise<string | null> => (
  (await client.query<{ paused_from: string }>(
    `SELECT to_char(s.check_out, 'YYYY-MM-DD') AS paused_from
       FROM employee_dormitory_stays s
      WHERE s.employee_id = $1 AND s.kind = 'apartment'
        AND (to_jsonb(s) ->> 'suspended')::boolean IS TRUE
        AND NOT EXISTS (
          SELECT 1 FROM employee_dormitory_stays r
           WHERE r.employee_id = s.employee_id AND (to_jsonb(r) ->> 'resumed_from_id')::int = s.id
        )
      ORDER BY s.check_out DESC
      LIMIT 1`,
    [employeeId],
  )).rows[0]?.paused_from ?? null
);

/** Служебной квартиры, в которую заселяют, нет (удалили) — ответ 404. */
export class CompanyApartmentNotFoundError extends Error {
  constructor() {
    super('Квартира не найдена');
    this.name = 'CompanyApartmentNotFoundError';
  }
}

/**
 * Добавить проживание. Жилец служебной квартиры (apartment_id) — адрес «Кв. <адрес>» берётся из квартиры в той же
 * транзакции (FOR SHARE: переименование квартиры дождётся записи); квартиры нет — CompanyApartmentNotFoundError.
 * Пересечение с другим проживанием сотрудника — 'overlap'; квартира в днях доплаты за общежитие —
 * DormitoryAllowanceConflictError (запись откатывается); компенсация при незавершённой паузе — CompensationPausedError.
 */
export const addStay = async (
  employeeId: number,
  input: IDormitoryStayInput,
): Promise<IDormitoryStay | 'overlap'> => {
  try {
    return await withTransaction(async client => {
      await lockPayrollEmployee(client, employeeId);
      if (input.kind === 'apartment') {
        const pausedFrom = await openPauseOf(client, employeeId);
        if (pausedFrom !== null) throw new CompensationPausedError(pausedFrom);
      }
      let address = input.address;
      if (input.apartment_id) {
        const apartment = (await client.query<{ address: string }>(
          `SELECT address FROM company_apartments WHERE id = $1 FOR SHARE`,
          [input.apartment_id],
        )).rows[0];
        if (!apartment) throw new CompanyApartmentNotFoundError();
        address = `Кв. ${apartment.address}`;
      }
      const row = (await client.query<{ id: number }>(
        `INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address, amount, apartment_id)
         VALUES ($1, $2, $3::date, $4::date, $5, $6, $7) RETURNING id`,
        [employeeId, input.kind, input.check_in, input.check_out, address, input.amount, input.apartment_id ?? null],
      )).rows[0];
      await afterWrite(client, { employee_id: employeeId, ...input, address }, null);
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
 * у общежития её нет). У жильца служебной квартиры адрес прежний (меняется только правкой квартиры) — даже если
 * прислан другой. Проживания нет — null; пересечение — 'overlap'; квартира в добавленных днях доплаты
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
            SET check_in = $2::date, check_out = $3::date,
                address = CASE WHEN apartment_id IS NULL THEN $4 ELSE address END,
                amount = COALESCE($5, amount),
                -- Снят выезд — паузы больше нет (CHECK employee_dormitory_stay_suspended, миграция 374).
                suspended = CASE WHEN $3::date IS NULL THEN false ELSE suspended END,
                updated_at = now()
          WHERE id = $1`,
        [id, input.check_in, input.check_out, input.address, input.amount],
      );
      await afterWrite(
        client,
        { employee_id: before.employee_id, kind: before.kind, apartment_id: before.apartment_id, ...input },
        before,
      );
      const after = await readStay(client, id, false);
      return after ? { before, after } : null;
    });
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};

/**
 * «Платно» и/или комментарий (PATCH /stays/:id/meta): остальные поля не трогаются; без изменений — та же строка, без
 * записи. «Платно» у общежития или компенсации — 'not_flat' (и CHECK employee_dormitory_stay_paid). Нет записи — null.
 */
export const updateStayMeta = async (
  id: number,
  input: { paid?: boolean; comment?: string | null },
): Promise<{ before: IDormitoryStay; after: IDormitoryStay } | 'not_flat' | null> =>
  withTransaction(async client => {
    const before = await readStay(client, id, true);
    if (!before) return null;
    if (input.paid === true && before.apartment_id === null) return 'not_flat';
    const paid = input.paid ?? before.paid;
    const comment = input.comment === undefined ? before.comment : input.comment;
    if (paid === before.paid && comment === before.comment) return { before, after: before };
    await client.query(
      `UPDATE employee_dormitory_stays SET paid = $2, comment = $3, updated_at = now() WHERE id = $1`,
      [id, paid, comment],
    );
    const after = await readStay(client, id, false);
    return after ? { before, after } : null;
  });

/** Удалить проживание (адрес в подсказках остаётся); его нет — null. */
export const deleteStay = async (id: number): Promise<IDormitoryStay | null> =>
  withTransaction(async client => {
    const before = await readStay(client, id, true);
    if (!before) return null;
    await client.query(`DELETE FROM employee_dormitory_stays WHERE id = $1`, [id]);
    return before;
  });
