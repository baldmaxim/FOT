/**
 * «Доплата за общежитие» — таблица окна «Справочник» на «Расчётах» (миграция 317): кому платят за то, что
 * он НЕ живёт в общежитии компании. Период «с — по» (по — включительно, NULL — бессрочно); прекратили —
 * ставят «по», строка остаётся историей; удаляют только ошибочную. Сумма одна на всех — значение ставки
 * dormitory_allowance на момент чтения. Отдел и должность — текущие.
 *
 * Правила записи — под lockPayrollEmployee, одной транзакцией с записью (и аудитом у вызывающего):
 * - в дни проживания в общежитии (employee_dormitory_stays, [въезд, выезд)) доплату не назначить;
 * - у сотрудника одна доплата из двух: «за проживание» (housing_compensation условий оплаты) или эта.
 * Правка проверяет только добавленные дни: сократить период или поставить «по» можно всегда, даже если
 * проживание в общежитии появилось позже.
 */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../../config/postgres.js';
import { DORMITORY_ALLOWANCE_RATE_CODE } from './payroll-rates.service.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';
import { lockPayrollEmployee } from './payroll-terms.service.js';

/** Нарушение EXCLUDE: у сотрудника уже есть период в эти даты. */
export const PG_EXCLUSION_VIOLATION = '23P01';

/** Проживание в общежитии, задевающее период доплаты: выезд — день выезда (не включается), null — живёт. */
export interface IDormitoryStayPeriod {
  check_in: string;
  check_out: string | null;
}

export interface IDormitoryAllowance {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** YYYY-MM-DD. */
  date_from: string;
  /** YYYY-MM-DD; бессрочно — null. */
  date_to: string | null;
  /** ₽/мес, numeric строкой: значение ставки; не задано — null. */
  amount: string | null;
  /** Для фильтра месяцев на клиенте: в месяцах проживания строка не показывается. */
  dormitory_stays: IDormitoryStayPeriod[];
}

export interface IDormitoryAllowanceInput {
  date_from: string;
  date_to: string | null;
}

export type DormitoryAllowanceConflictCode = 'LIVES_IN_DORMITORY' | 'HAS_HOUSING' | 'HAS_DORMITORY_ALLOWANCE';

/** Запись нарушает правило — бросается внутри транзакции (откат), контроллер отвечает 409 с этим текстом. */
export class DormitoryAllowanceConflictError extends Error {
  constructor(readonly code: DormitoryAllowanceConflictCode, message: string) {
    super(message);
  }
}

const ALLOWANCE_SELECT = `
  SELECT a.id, a.employee_id, e.full_name, d.name AS department, p.name AS position,
         to_char(a.date_from, 'YYYY-MM-DD') AS date_from,
         to_char(a.date_to, 'YYYY-MM-DD') AS date_to,
         (SELECT r.amount::text FROM payroll_rates r WHERE r.code = '${DORMITORY_ALLOWANCE_RATE_CODE}') AS amount,
         COALESCE((
           SELECT json_agg(json_build_object(
                    'check_in', to_char(s.check_in, 'YYYY-MM-DD'),
                    'check_out', to_char(s.check_out, 'YYYY-MM-DD')
                  ) ORDER BY s.check_in)
             FROM employee_dormitory_stays s
            WHERE s.employee_id = a.employee_id
              AND daterange(s.check_in, s.check_out, '[)') && daterange(a.date_from, a.date_to, '[]')
         ), '[]'::json) AS dormitory_stays
    FROM payroll_dormitory_allowances a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions p ON p.id = e.position_id`;

/** Все периоды (история) «штата зарплаты» в порядке ФИО и даты начала. */
export const listDormitoryAllowances = async (scope: {
  contractorRootId: string | null;
  departmentIds: string[] | null;
}): Promise<IDormitoryAllowance[]> => {
  if (scope.departmentIds?.length === 0) return [];
  return query<IDormitoryAllowance>(
    `WITH ${payrollContractorDeptsCte('$1')}
     ${ALLOWANCE_SELECT}
      WHERE ${payrollStaffWhereSql('e', '$2')}
      ORDER BY e.full_name, a.employee_id, a.date_from, a.id`,
    [scope.contractorRootId, scope.departmentIds],
  );
};

export const getDormitoryAllowance = async (id: number): Promise<IDormitoryAllowance | null> =>
  queryOne<IDormitoryAllowance>(`${ALLOWANCE_SELECT} WHERE a.id = $1`, [id]);

const readAllowance = async (client: PoolClient, id: number, lock: boolean): Promise<IDormitoryAllowance | null> =>
  (await client.query<IDormitoryAllowance>(`${ALLOWANCE_SELECT} WHERE a.id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [id]))
    .rows[0] ?? null;

/**
 * Какие дни проверять: новый период минус прежний (у добавления прежнего нет). Сокращение даёт пустое
 * окно — проверять нечего. Параметры: $2/$3 — новый «с — по», $4/$5 — прежний (NULL — нет).
 */
interface ICheckWindow {
  from: string;
  to: string | null;
  previous: IDormitoryAllowanceInput | null;
}

const WINDOW_CTE = `win AS (
    SELECT datemultirange(daterange($2::date, $3::date, '[]'))
           - CASE WHEN $4::date IS NULL THEN '{}'::datemultirange
                  ELSE datemultirange(daterange($4::date, $5::date, '[]')) END AS days
  )`;

const windowParams = (employeeId: number, window: ICheckWindow): unknown[] => [
  employeeId, window.from, window.to, window.previous?.date_from ?? null, window.previous?.date_to ?? null,
];

const formatRu = (iso: string): string => iso.split('-').reverse().join('.');

/** Проживание в общежитии в днях окна — первое по дате; нет — null. */
const findStayInWindow = async (
  client: PoolClient,
  employeeId: number,
  window: ICheckWindow,
): Promise<IDormitoryStayPeriod | null> => (await client.query<IDormitoryStayPeriod>(
  `WITH ${WINDOW_CTE}
   SELECT to_char(s.check_in, 'YYYY-MM-DD') AS check_in, to_char(s.check_out, 'YYYY-MM-DD') AS check_out
     FROM win
     JOIN employee_dormitory_stays s ON s.employee_id = $1
    WHERE win.days && daterange(s.check_in, s.check_out, '[)')
    ORDER BY s.check_in
    LIMIT 1`,
  windowParams(employeeId, window),
)).rows[0] ?? null;

/**
 * Первый день окна, в который у сотрудника одновременно доплата за проживание (версия условий с
 * housing_compensation > 0) и доплата за общежитие — по тому, что уже записано в транзакции; нет — null.
 * Общая проверка всех трёх путей: таблица «Доплата за общежитие», таблица «Доплата за проживание» и окно сотрудника.
 */
export const findHousingAllowanceConflict = async (
  client: PoolClient,
  employeeId: number,
  window: ICheckWindow,
): Promise<string | null> => (await client.query<{ day: string }>(
  `WITH ${WINDOW_CTE},
   hits AS (
     SELECT win.days
            * datemultirange(daterange(v.effective_from, v.effective_to, '[]'))
            * datemultirange(daterange(a.date_from, a.date_to, '[]')) AS days
       FROM win
       JOIN payroll_compensation_terms v ON v.employee_id = $1 AND v.housing_compensation > 0
       JOIN payroll_dormitory_allowances a ON a.employee_id = $1
   )
   SELECT to_char(lower(days), 'YYYY-MM-DD') AS day
     FROM hits
    WHERE NOT isempty(days)
    ORDER BY lower(days)
    LIMIT 1`,
  windowParams(employeeId, window),
)).rows[0]?.day ?? null;

/**
 * Доплата за проживание записана с даты from (таблица или окно сотрудника): в эти дни не должно быть доплаты
 * за общежитие. Вызывать в транзакции после записи, под lockPayrollEmployee — иначе бросает (откат).
 */
export const assertHousingWithoutDormitoryAllowance = async (
  client: PoolClient,
  employeeId: number,
  from: string,
): Promise<void> => {
  const day = await findHousingAllowanceConflict(client, employeeId, { from, to: null, previous: null });
  if (day) {
    throw new DormitoryAllowanceConflictError(
      'HAS_DORMITORY_ALLOWANCE',
      `С ${formatRu(day)} у сотрудника доплата за общежитие — одновременно с ней доплату за проживание назначить нельзя`,
    );
  }
};

/** Проверки доплаты за общежитие в добавленных днях; запись уже сделана (проверка доплаты за проживание — по ней). */
const assertAllowanceDays = async (client: PoolClient, employeeId: number, window: ICheckWindow): Promise<void> => {
  const stay = await findStayInWindow(client, employeeId, window);
  if (stay) {
    const until = stay.check_out ? `, выезд ${formatRu(stay.check_out)}` : '';
    throw new DormitoryAllowanceConflictError(
      'LIVES_IN_DORMITORY',
      `В эти даты сотрудник живёт в общежитии (въезд ${formatRu(stay.check_in)}${until}) — доплату за общежитие назначить нельзя`,
    );
  }
  const day = await findHousingAllowanceConflict(client, employeeId, window);
  if (day) {
    throw new DormitoryAllowanceConflictError(
      'HAS_HOUSING',
      `С ${formatRu(day)} у сотрудника доплата за проживание — одновременно с ней доплату за общежитие назначить нельзя`,
    );
  }
};

export type DormitoryAllowanceSaveResult = { status: 'saved' | 'unchanged'; allowance: IDormitoryAllowance };

/**
 * Добавить период (вызывать в транзакции). Такой же период у сотрудника уже есть (двойной клик, повтор
 * запроса) — 'unchanged' с ним. Пересечение с другим периодом — ошибка 23P01 (EXCLUDE), правило — DormitoryAllowanceConflictError.
 */
export const addDormitoryAllowance = async (
  client: PoolClient,
  employeeId: number,
  input: IDormitoryAllowanceInput,
): Promise<DormitoryAllowanceSaveResult> => {
  await lockPayrollEmployee(client, employeeId);
  const same = (await client.query<{ id: number }>(
    `SELECT id FROM payroll_dormitory_allowances
      WHERE employee_id = $1 AND date_from = $2::date AND date_to IS NOT DISTINCT FROM $3::date`,
    [employeeId, input.date_from, input.date_to],
  )).rows[0];
  if (same) {
    const allowance = await readAllowance(client, same.id, false);
    if (!allowance) throw new Error('Период не найден');
    return { status: 'unchanged', allowance };
  }

  const inserted = (await client.query<{ id: number }>(
    `INSERT INTO payroll_dormitory_allowances (employee_id, date_from, date_to)
     VALUES ($1, $2::date, $3::date) RETURNING id`,
    [employeeId, input.date_from, input.date_to],
  )).rows[0];
  await assertAllowanceDays(client, employeeId, { from: input.date_from, to: input.date_to, previous: null });
  const allowance = await readAllowance(client, inserted.id, false);
  if (!allowance) throw new Error('Период не найден после добавления');
  return { status: 'saved', allowance };
};

/**
 * Изменить даты (вызывать в транзакции); периода нет — null. Те же даты — 'unchanged'. Проверяются только
 * добавленные дни. Возвращает и прежний вид — для аудита «было → стало».
 */
export const updateDormitoryAllowance = async (
  client: PoolClient,
  id: number,
  input: IDormitoryAllowanceInput,
): Promise<(DormitoryAllowanceSaveResult & { before: IDormitoryAllowance }) | null> => {
  const current = await readAllowance(client, id, false);
  if (!current) return null;
  // Блокировка сотрудника — до чтения под FOR UPDATE: тот же порядок, что у добавления и у условий оплаты.
  await lockPayrollEmployee(client, current.employee_id);
  const before = await readAllowance(client, id, true);
  if (!before) return null;
  if (before.date_from === input.date_from && before.date_to === input.date_to) {
    return { status: 'unchanged', allowance: before, before };
  }

  await client.query(
    `UPDATE payroll_dormitory_allowances
        SET date_from = $2::date, date_to = $3::date, updated_at = now()
      WHERE id = $1`,
    [id, input.date_from, input.date_to],
  );
  await assertAllowanceDays(client, before.employee_id, {
    from: input.date_from,
    to: input.date_to,
    previous: { date_from: before.date_from, date_to: before.date_to },
  });
  const allowance = await readAllowance(client, id, false);
  if (!allowance) return null;
  return { status: 'saved', allowance, before };
};

/** Удалить ошибочный период (вызывать в транзакции); его нет — null. */
export const deleteDormitoryAllowance = async (client: PoolClient, id: number): Promise<IDormitoryAllowance | null> => {
  const current = await readAllowance(client, id, false);
  if (!current) return null;
  await lockPayrollEmployee(client, current.employee_id);
  const before = await readAllowance(client, id, true);
  if (!before) return null;
  await client.query(`DELETE FROM payroll_dormitory_allowances WHERE id = $1`, [id]);
  return before;
};
