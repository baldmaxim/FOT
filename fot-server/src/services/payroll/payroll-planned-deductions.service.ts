/**
 * Плановые удержания (миграция 357): вид, подвид, сумма ₽/мес на месяцы «с — по» (по — необязательно, бессрочно);
 * в последнем месяце периода — своя сумма, если задана (миграция 362).
 *
 * Одни записи ведут кадры («Управление кадрами» → «Удержания») и «Зарплата» («Справочник» → «Удержания»): охват —
 * параметром. В расчётах плановые разворачивает по месяцам payroll-month-deductions.sql.ts (вся сумма в каждом
 * месяце); таблица «Удержания за месяц» берёт развёртку тем же SQL — цифры совпадают с «Расчётами» и «Сводом».
 *
 * Правила записи (все — после lockPayrollEmployee в одной транзакции):
 * - у сотрудника не может быть двух пересекающихся периодов одного вида и подвида (без подвида — тоже один «подвид»);
 *   разные виды и разные подвиды одного вида — можно;
 * - правка и «Убрать» — по updated_at, полученному с таблицей: строку уже изменили (или повтор того же запроса) —
 *   'stale', ничего не пишется;
 * - сохранение без изменений — ничего не пишет;
 * - «Убрать» (C — текущий месяц МСК): период начинается с C или позже либо кончился до C — строка удаляется,
 *   иначе закрывается месяцем перед C (прошлые месяцы остаются в расчётах) и сумма последнего месяца снимается:
 *   закрытый месяц уже удержан обычной суммой;
 * - каждое изменение — строка истории для карточки (payroll_planned_deduction_changes).
 */
import type { PoolClient } from 'pg';

import { query, withTransaction } from '../../config/postgres.js';
import { hasPgCode, PG_FOREIGN_KEY_VIOLATION, pgConstraintName } from './payroll-pg-errors.js';
import { plannedDeductionMonthsSql } from './payroll-month-deductions.sql.js';
import { payrollContractorDeptsCte, payrollStaffWhereSql } from './payroll-registry-scope.service.js';
import { lockPayrollEmployee } from './payroll-terms.service.js';

export interface IPlannedDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  subkind_id: number | null;
  subkind_name: string | null;
  /** NUMERIC текстом: «5000.00». */
  amount: string;
  /** YYYY-MM. */
  month_from: string;
  /** YYYY-MM; null — бессрочно. */
  month_to: string | null;
  /** Сумма в месяце month_to вместо amount (NUMERIC текстом); null — как в остальных месяцах. */
  last_month_amount: string | null;
  /** Метка версии строки (ISO, микросекунды) — правка и «Убрать» присылают её обратно. */
  updated_at: string;
}

/** Плановое удержание в одном месяце — строка таблицы «Удержания за месяц». */
export interface IPlannedDeductionMonth extends IPlannedDeduction {
  /** YYYY-MM. */
  month: string;
  /** Удержание в этом месяце (NUMERIC текстом): в последнем месяце — last_month_amount, если задана; amount — сумма периода. */
  month_amount: string;
}

export interface IPlannedDeductionInput {
  kind_id: number;
  subkind_id: number | null;
  amount: number;
  /** YYYY-MM. */
  month_from: string;
  /** YYYY-MM; null — бессрочно. */
  month_to: string | null;
  /** Сумма в последнем месяце; null — как в остальных. */
  last_month_amount: number | null;
}

/** Запись истории для карточки. Суммы — текстом NUMERIC, месяцы — YYYY-MM. */
export interface IPlannedDeductionChange {
  id: number;
  planned_id: number;
  action: 'assigned' | 'changed' | 'closed' | 'removed';
  kind_name: string | null;
  subkind_name: string | null;
  amount: string | null;
  month_from: string | null;
  month_to: string | null;
  last_month_amount: string | null;
  prev_kind_name: string | null;
  prev_subkind_name: string | null;
  prev_amount: string | null;
  prev_month_from: string | null;
  prev_month_to: string | null;
  prev_last_month_amount: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/**
 * Охват списков: «штат зарплаты» («Зарплата»: работающие, не подрядчики, отделы — departmentIds, null — все) или
 * набор сотрудников (кадры: список кадров, null — без ограничения).
 */
export type PlannedDeductionScope =
  | { kind: 'payroll'; contractorRootId: string | null; departmentIds: string[] | null }
  | { kind: 'employees'; employeeIds: number[] | null };

export type PlannedDeductionRefMissing = 'kind_missing' | 'subkind_missing';

/** Отказ записи: пересечение периодов (с найденным периодом) или строку уже изменили. */
export type PlannedDeductionConflict =
  | { conflict: 'exists'; existing: IPlannedDeduction }
  | { conflict: 'stale' };

const SUBKIND_FK = 'payroll_planned_deductions_subkind_fk';

const refMissing = (err: unknown): PlannedDeductionRefMissing | null => {
  if (!hasPgCode(err, PG_FOREIGN_KEY_VIOLATION)) return null;
  return pgConstraintName(err) === SUBKIND_FK ? 'subkind_missing' : 'kind_missing';
};

const SELECT_COLUMNS = `
  p.id, p.employee_id, e.full_name, d.name AS department, ps.name AS position,
  p.kind_id, k.name AS kind_name, p.subkind_id, sk.name AS subkind_name,
  p.amount::text AS amount,
  to_char(p.month_from, 'YYYY-MM') AS month_from,
  to_char(p.month_to, 'YYYY-MM') AS month_to,
  p.last_month_amount::text AS last_month_amount,
  to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

const SELECT_JOINS = `
    JOIN employees e ON e.id = p.employee_id
    JOIN payroll_deduction_kinds k ON k.id = p.kind_id
    LEFT JOIN payroll_deduction_subkinds sk ON sk.id = p.subkind_id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
    LEFT JOIN positions ps ON ps.id = e.position_id`;

/** Условие охвата для сотрудника e и параметры с номера firstParam; CTE — для «штата зарплаты». */
const scopeSql = (scope: PlannedDeductionScope, firstParam: number): { cte: string; where: string; params: unknown[] } => {
  if (scope.kind === 'payroll') {
    const root = `$${firstParam}`;
    const departments = `$${firstParam + 1}`;
    return {
      cte: `WITH ${payrollContractorDeptsCte(root)}`,
      where: payrollStaffWhereSql('e', departments),
      params: [scope.contractorRootId, scope.departmentIds],
    };
  }
  const ids = `$${firstParam}`;
  return { cte: '', where: `(${ids}::int[] IS NULL OR e.id = ANY(${ids}::int[]))`, params: [scope.employeeIds] };
};

const isEmptyScope = (scope: PlannedDeductionScope): boolean => (
  scope.kind === 'payroll' ? scope.departmentIds?.length === 0 : scope.employeeIds?.length === 0
);

/**
 * Периоды, задевающие месяцы (monthStarts — date 1-го числа; null — все периоды), в порядке ФИО, начала, id.
 */
export const listPlannedDeductions = async (
  scope: PlannedDeductionScope,
  monthStarts: readonly string[] | null,
): Promise<IPlannedDeduction[]> => {
  if (isEmptyScope(scope)) return [];
  const { cte, where, params } = scopeSql(scope, 2);
  return query<IPlannedDeduction>(
    `${cte}
     SELECT ${SELECT_COLUMNS}
       FROM payroll_planned_deductions p
       ${SELECT_JOINS}
      WHERE ${where}
        AND ($1::date[] IS NULL OR EXISTS (
              SELECT 1 FROM unnest($1::date[]) AS m(month)
               WHERE p.month_from <= m.month AND (p.month_to IS NULL OR p.month_to >= m.month)))
      ORDER BY e.full_name, e.id, p.month_from, p.id`,
    [monthStarts === null ? null : [...monthStarts], ...params],
  );
};

/**
 * Плановые по месяцам (monthStarts — date 1-го числа, непусто) — то же правило, что в расчёте
 * (plannedDeductionMonthsSql): строка на каждый месяц, где удержание идёт. Порядок — ФИО, месяц, начало, id.
 */
export const listPlannedDeductionMonths = async (
  scope: PlannedDeductionScope,
  monthStarts: readonly string[],
): Promise<IPlannedDeductionMonth[]> => {
  if (isEmptyScope(scope) || monthStarts.length === 0) return [];
  const { cte, where, params } = scopeSql(scope, 2);
  return query<IPlannedDeductionMonth>(
    `${cte}
     SELECT ${SELECT_COLUMNS}, to_char(pm.month, 'YYYY-MM') AS month, pm.amount::text AS month_amount
       FROM (${plannedDeductionMonthsSql('$1', 'NULL')}) pm
       JOIN payroll_planned_deductions p ON p.id = pm.planned_id
       ${SELECT_JOINS}
      WHERE ${where}
      ORDER BY e.full_name, e.id, pm.month, p.month_from, p.id`,
    [[...monthStarts], ...params],
  );
};

/** Все плановые сотрудника (окно сотрудника): новые сверху. Без охвата штата — уволенный видит свои. */
export const listEmployeePlannedDeductions = async (employeeId: number): Promise<IPlannedDeduction[]> =>
  query<IPlannedDeduction>(
    `SELECT ${SELECT_COLUMNS}
       FROM payroll_planned_deductions p
       ${SELECT_JOINS}
      WHERE p.employee_id = $1
      ORDER BY p.month_from DESC, p.id DESC`,
    [employeeId],
  );

/** История сотрудника для карточки: новые сверху. */
export const listPlannedDeductionChanges = async (employeeId: number): Promise<IPlannedDeductionChange[]> =>
  query<IPlannedDeductionChange>(
    `SELECT c.id::int AS id, c.planned_id, c.action,
            c.kind_name, c.subkind_name, c.amount::text AS amount,
            to_char(c.month_from, 'YYYY-MM') AS month_from, to_char(c.month_to, 'YYYY-MM') AS month_to,
            c.last_month_amount::text AS last_month_amount,
            c.prev_kind_name, c.prev_subkind_name, c.prev_amount::text AS prev_amount,
            to_char(c.prev_month_from, 'YYYY-MM') AS prev_month_from, to_char(c.prev_month_to, 'YYYY-MM') AS prev_month_to,
            c.prev_last_month_amount::text AS prev_last_month_amount,
            up.full_name AS changed_by_name,
            to_char(c.changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS changed_at
       FROM payroll_planned_deduction_changes c
       LEFT JOIN user_profiles up ON up.id = c.changed_by
      WHERE c.employee_id = $1
      ORDER BY c.id DESC`,
    [employeeId],
  );

export const getPlannedDeduction = async (id: number): Promise<IPlannedDeduction | null> =>
  (await query<IPlannedDeduction>(
    `SELECT ${SELECT_COLUMNS} FROM payroll_planned_deductions p ${SELECT_JOINS} WHERE p.id = $1`,
    [id],
  ))[0] ?? null;

const readRow = async (client: PoolClient, id: number, lock: boolean): Promise<IPlannedDeduction | null> =>
  (await client.query<IPlannedDeduction>(
    `SELECT ${SELECT_COLUMNS} FROM payroll_planned_deductions p ${SELECT_JOINS}
      WHERE p.id = $1${lock ? ' FOR UPDATE OF p' : ''}`,
    [id],
  )).rows[0] ?? null;

const monthStart = (month: string | null): string | null => (month === null ? null : `${month}-01`);

/** Пересекающийся период того же вида и подвида у сотрудника (кроме exceptId); нет — null. */
const findOverlap = async (
  client: PoolClient,
  employeeId: number,
  input: IPlannedDeductionInput,
  exceptId: number | null,
): Promise<IPlannedDeduction | null> => {
  const found = await client.query<{ id: number }>(
    `SELECT id FROM payroll_planned_deductions
      WHERE employee_id = $1
        AND kind_id = $2
        AND subkind_id IS NOT DISTINCT FROM $3::int
        AND ($5::date IS NULL OR month_from <= $5::date)
        AND (month_to IS NULL OR month_to >= $4::date)
        AND ($6::int IS NULL OR id <> $6::int)
      ORDER BY month_from, id
      LIMIT 1`,
    [employeeId, input.kind_id, input.subkind_id, monthStart(input.month_from), monthStart(input.month_to), exceptId],
  );
  const id = found.rows[0]?.id;
  return id === undefined ? null : readRow(client, id, false);
};

type ChangeAction = IPlannedDeductionChange['action'];

const insertChange = async (
  client: PoolClient,
  change: { action: ChangeAction; plannedId: number; employeeId: number; after: IPlannedDeduction | null;
    before: IPlannedDeduction | null; actorId: string | null },
): Promise<void> => {
  const { after, before } = change;
  await client.query(
    `INSERT INTO payroll_planned_deduction_changes (
       planned_id, employee_id, action,
       kind_name, subkind_name, amount, month_from, month_to, last_month_amount,
       prev_kind_name, prev_subkind_name, prev_amount, prev_month_from, prev_month_to, prev_last_month_amount,
       changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11, $12, $13::date, $14::date, $15, $16)`,
    [
      change.plannedId, change.employeeId, change.action,
      after?.kind_name ?? null, after?.subkind_name ?? null, after?.amount ?? null,
      monthStart(after?.month_from ?? null), monthStart(after?.month_to ?? null), after?.last_month_amount ?? null,
      before?.kind_name ?? null, before?.subkind_name ?? null, before?.amount ?? null,
      monthStart(before?.month_from ?? null), monthStart(before?.month_to ?? null), before?.last_month_amount ?? null,
      change.actorId,
    ],
  );
};

/** Ловит FK вида/подвида снаружи транзакции (ошибка внутри прерывает её — откат делает withTransaction). */
const withRefMissing = async <T>(fn: () => Promise<T>): Promise<T | PlannedDeductionRefMissing> => {
  try {
    return await fn();
  } catch (err) {
    const missing = refMissing(err);
    if (missing) return missing;
    throw err;
  }
};

/** Добавить плановое; пересечение — { conflict: 'exists' }; вида или подвида нет — 'kind_missing' / 'subkind_missing'. */
export const addPlannedDeduction = async (
  employeeId: number,
  input: IPlannedDeductionInput,
  actorId: string | null,
): Promise<IPlannedDeduction | PlannedDeductionConflict | PlannedDeductionRefMissing> =>
  withRefMissing(() => withTransaction(async client => {
    await lockPayrollEmployee(client, employeeId);
    const existing = await findOverlap(client, employeeId, input, null);
    if (existing) return { conflict: 'exists' as const, existing };
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO payroll_planned_deductions (employee_id, kind_id, subkind_id, amount, month_from, month_to, last_month_amount)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7) RETURNING id`,
      [
        employeeId, input.kind_id, input.subkind_id, input.amount,
        monthStart(input.month_from), monthStart(input.month_to), input.last_month_amount,
      ],
    );
    const row = await readRow(client, inserted.rows[0].id, false);
    if (!row) throw new Error('Плановое удержание не найдено после добавления');
    await insertChange(client, { action: 'assigned', plannedId: row.id, employeeId, after: row, before: null, actorId });
    return row;
  }));

/** Сумма в копейках; null — нет суммы. */
const kopecks = (amount: string | number | null): number | null => (
  amount === null ? null : Math.round(Number(amount) * 100)
);

/** Совпадает ли ввод с записью: тогда сохранять нечего. Суммы сравниваются в копейках. */
const sameAsInput = (row: IPlannedDeduction, input: IPlannedDeductionInput): boolean => (
  row.kind_id === input.kind_id
  && row.subkind_id === input.subkind_id
  && kopecks(row.amount) === kopecks(input.amount)
  && row.month_from === input.month_from
  && row.month_to === input.month_to
  && kopecks(row.last_month_amount) === kopecks(input.last_month_amount)
);

/** Строка, заблокированная вместе с сотрудником; нет — null, updated_at не тот — 'stale'. */
const lockRow = async (
  client: PoolClient,
  id: number,
  expectedUpdatedAt: string,
): Promise<IPlannedDeduction | 'stale' | null> => {
  const first = await readRow(client, id, false);
  if (!first) return null;
  await lockPayrollEmployee(client, first.employee_id);
  const row = await readRow(client, id, true);
  if (!row) return null;
  const same = await client.query<{ same: boolean }>(
    `SELECT updated_at = $2::timestamptz AS same FROM payroll_planned_deductions WHERE id = $1`,
    [id, expectedUpdatedAt],
  );
  return same.rows[0]?.same === true ? row : 'stale';
};

/**
 * Изменить вид, подвид, сумму, период и сумму последнего месяца (сотрудник не меняется). Нет строки — null; уже изменили — { conflict: 'stale' };
 * пересечение — { conflict: 'exists' }; вида или подвида нет — 'kind_missing' / 'subkind_missing'. Без изменений —
 * changed: false, ничего не записано.
 */
export const updatePlannedDeduction = async (
  id: number,
  input: IPlannedDeductionInput,
  expectedUpdatedAt: string,
  actorId: string | null,
): Promise<
  { before: IPlannedDeduction; after: IPlannedDeduction; changed: boolean }
  | PlannedDeductionConflict | PlannedDeductionRefMissing | null
> =>
  withRefMissing(() => withTransaction(async client => {
    const before = await lockRow(client, id, expectedUpdatedAt);
    if (before === null) return null;
    if (before === 'stale') return { conflict: 'stale' as const };
    if (sameAsInput(before, input)) return { before, after: before, changed: false };
    const existing = await findOverlap(client, before.employee_id, input, id);
    if (existing) return { conflict: 'exists' as const, existing };
    await client.query(
      `UPDATE payroll_planned_deductions
          SET kind_id = $2, subkind_id = $3, amount = $4, month_from = $5::date, month_to = $6::date,
              last_month_amount = $7, updated_at = clock_timestamp()
        WHERE id = $1`,
      [
        id, input.kind_id, input.subkind_id, input.amount,
        monthStart(input.month_from), monthStart(input.month_to), input.last_month_amount,
      ],
    );
    const after = await readRow(client, id, false);
    if (!after) throw new Error('Плановое удержание не найдено после правки');
    await insertChange(client, {
      action: 'changed', plannedId: id, employeeId: before.employee_id, after, before, actorId,
    });
    return { before, after, changed: true };
  }));

/** Что делает «Убрать» с периодом в текущем месяце currentMonth (YYYY-MM): удалить или закрыть месяцем раньше. */
export const plannedDeductionRemovalAction = (
  period: { month_from: string; month_to: string | null },
  currentMonth: string,
): 'remove' | 'close' => (
  period.month_from >= currentMonth || (period.month_to !== null && period.month_to < currentMonth) ? 'remove' : 'close'
);

/** YYYY-MM на месяц раньше. */
const previousMonth = (month: string): string => {
  const [year, value] = month.split('-').map(Number);
  const index = year * 12 + value - 2;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/**
 * «Убрать» (currentMonth — текущий месяц МСК, YYYY-MM): закрыть идущий период месяцем перед текущим (сумма
 * последнего месяца снимается — закрытый месяц удержан обычной суммой) или удалить не начавшийся / кончившийся. Нет строки — null; уже изменили (в т.ч. повторный запрос) — { conflict: 'stale' }.
 */
export const removePlannedDeduction = async (
  id: number,
  expectedUpdatedAt: string,
  currentMonth: string,
  actorId: string | null,
): Promise<
  { action: 'closed'; before: IPlannedDeduction; after: IPlannedDeduction }
  | { action: 'removed'; before: IPlannedDeduction }
  | { conflict: 'stale' } | null
> =>
  withTransaction(async client => {
    const before = await lockRow(client, id, expectedUpdatedAt);
    if (before === null) return null;
    if (before === 'stale') return { conflict: 'stale' as const };
    if (plannedDeductionRemovalAction(before, currentMonth) === 'remove') {
      await client.query(`DELETE FROM payroll_planned_deductions WHERE id = $1`, [id]);
      await insertChange(client, {
        action: 'removed', plannedId: id, employeeId: before.employee_id, after: null, before, actorId,
      });
      return { action: 'removed' as const, before };
    }
    await client.query(
      `UPDATE payroll_planned_deductions
          SET month_to = $2::date, last_month_amount = NULL, updated_at = clock_timestamp()
        WHERE id = $1`,
      [id, monthStart(previousMonth(currentMonth))],
    );
    const after = await readRow(client, id, false);
    if (!after) throw new Error('Плановое удержание не найдено после закрытия');
    await insertChange(client, {
      action: 'closed', plannedId: id, employeeId: before.employee_id, after, before, actorId,
    });
    return { action: 'closed' as const, before, after };
  });
