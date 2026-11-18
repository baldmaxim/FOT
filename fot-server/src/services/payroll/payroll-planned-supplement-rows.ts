/**
 * Строки плановых доплат (миграция 369). Каждая неархивная строка с суммой — самостоятельная действующая доплата:
 * у сотрудника их может быть несколько на одни и те же даты (разные доплаты, у каждой свой комментарий), перекрытия
 * ничего не скрывают. Правка — строка в архив и новая с replaces_id; снятие — строка в архив и архивная строка
 * «снята» (amount NULL) с replaces_id: так «История изменений» видит «было». Вставки — с legacy_journal = false,
 * иначе их отклонит триггер 369 (он ловит код до 369, который дописывал версии без архивации).
 *
 * Вызывать в транзакции под lockPayrollEmployee: проверка дубля и запись должны идти без гонки.
 */
import type { DbExecutor } from '../../config/postgres.js';
import type { IPlannedSupplementValue } from './payroll-terms.service.js';

/**
 * Действующие плановые доплаты всех сотрудников: неархивные строки с суммой. Фильтр по месяцу — снаружи.
 * Его читают расчёт ФОТ, «Справочник» и синк; комментарий — из строки журнала (JOIN по id), здесь его нет.
 */
export const PLANNED_SUPPLEMENT_PERIODS_SQL = `
  SELECT x.id, x.employee_id, x.amount, x.date_from, x.date_to
    FROM payroll_planned_supplements x
   WHERE x.archived_at IS NULL AND x.amount IS NOT NULL`;

/** Действующая плановая доплата: id строки и значение с комментарием. */
export interface IPlannedPeriod {
  id: number;
  amount: number;
  dateFrom: string;
  /** null — бессрочно. */
  dateTo: string | null;
  comment: string | null;
}

/** Значение для записи: комментарий undefined уже разрешён (у новой — null, у правки — комментарий строки). */
type ResolvedValue = Omit<IPlannedPeriod, 'id'>;

const toCents = (amount: number): number => Math.round(amount * 100);

/** Та же доплата: сумма, даты и комментарий. */
export const samePlannedValue = (a: ResolvedValue, b: ResolvedValue): boolean => (
  toCents(a.amount) === toCents(b.amount)
  && a.dateFrom === b.dateFrom
  && a.dateTo === b.dateTo
  && a.comment === b.comment
);

/** Комментарий значения: undefined (не передан) — fallback (у правки — комментарий строки, у новой — null). */
export const resolvePlannedValue = (value: IPlannedSupplementValue, fallbackComment: string | null): ResolvedValue => ({
  amount: value.amount,
  dateFrom: value.dateFrom,
  dateTo: value.dateTo,
  comment: value.comment === undefined ? fallbackComment : value.comment,
});

/**
 * Действующие доплаты сотрудника: последний по дате период первым (date_from DESC, id DESC) — его правит путь
 * прежних клиентов, тот же порядок у списка в окне сотрудника.
 */
export const readPlannedPeriods = async (exec: DbExecutor, employeeId: number): Promise<IPlannedPeriod[]> => (
  (await exec.query<{ id: number; amount: string; date_from: string; date_to: string | null; comment: string | null }>(
    `SELECT x.id::int AS id, x.amount::text AS amount,
            to_char(x.date_from, 'YYYY-MM-DD') AS date_from,
            to_char(x.date_to, 'YYYY-MM-DD') AS date_to,
            x.comment
       FROM payroll_planned_supplements x
      WHERE x.employee_id = $1 AND x.archived_at IS NULL AND x.amount IS NOT NULL
      ORDER BY x.date_from DESC, x.id DESC`,
    [employeeId],
  )).rows.map(row => ({
    id: row.id,
    amount: Number(row.amount),
    dateFrom: row.date_from,
    dateTo: row.date_to,
    comment: row.comment,
  }))
);

/** Значение доплаты без id — для аудита («было» / «стало»). */
export const plannedValueOf = (period: IPlannedPeriod): IPlannedSupplementValue => ({
  amount: period.amount,
  dateFrom: period.dateFrom,
  dateTo: period.dateTo,
  comment: period.comment,
});

/** Новая действующая доплата. */
export const insertPlannedPeriod = async (
  exec: DbExecutor,
  input: { employeeId: number; value: ResolvedValue; createdBy: string | null; replacesId?: number | null },
): Promise<void> => {
  await exec.query(
    `INSERT INTO payroll_planned_supplements
       (employee_id, amount, date_from, date_to, comment, created_by, replaces_id, legacy_journal)
     VALUES ($1, $2::numeric, $3::date, $4::date, $5, $6, $7, false)`,
    [
      input.employeeId,
      input.value.amount,
      input.value.dateFrom,
      input.value.dateTo,
      input.value.comment,
      input.createdBy,
      input.replacesId ?? null,
    ],
  );
};

/**
 * Заменить (value) или снять (null) одну действующую доплату: строка — в архив; правка — новая строка с replaces_id,
 * снятие — архивная строка «снята» с replaces_id (в действующие не попадает, в истории — «снята»).
 */
export const replacePlannedPeriod = async (
  exec: DbExecutor,
  input: { employeeId: number; target: IPlannedPeriod; value: ResolvedValue | null; createdBy: string | null },
): Promise<void> => {
  await exec.query(
    'UPDATE payroll_planned_supplements SET archived_at = now() WHERE id = $1 AND archived_at IS NULL',
    [input.target.id],
  );
  if (input.value) {
    await insertPlannedPeriod(exec, {
      employeeId: input.employeeId,
      value: input.value,
      createdBy: input.createdBy,
      replacesId: input.target.id,
    });
    return;
  }
  await exec.query(
    `INSERT INTO payroll_planned_supplements
       (employee_id, amount, date_from, date_to, created_by, replaces_id, archived_at, legacy_journal)
     VALUES ($1, NULL, NULL, NULL, $2, $3, now(), false)`,
    [input.employeeId, input.createdBy, input.target.id],
  );
};
