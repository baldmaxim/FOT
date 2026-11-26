/**
 * «Компенсация аренды»: приостановить, возобновить, завершить паузу (миграция 374, решения пользователя 20.11.2026).
 *
 * В расчёте пауза — обычный промежуток между записями вида 'apartment' (дни всех записей месяца складываются,
 * payroll-payslip.rules.ts); колонки 374 нужны экрану:
 * - «Приостановить с даты» — выезд записи = дата, suspended = true;
 * - «Возобновить с даты» — новая запись с той же ставкой и комментарием, resumed_from_id = приостановленная; дата не
 *   раньше паузы (в ту же дату — без промежутка). Повтор с той же датой — та же запись (repeated); у паузы одно
 *   возобновление (UNIQUE): с другой датой — 'already_resumed';
 * - «Завершить» — пауза становится обычным окончанием (suspended = false): строка уходит из следующих месяцев.
 * Всё — в транзакции под lockPayrollEmployee (тот же замок, что у правки проживаний и доплат «Зарплаты»); квартира в
 * днях «Доплаты за общежитие» — DormitoryAllowanceConflictError, пересечение с другим проживанием — 'overlap'.
 * openFrom (вкладка кадров, миграция 380) — начало открытого периода: пауза и возобновление не меняют дни закрытых
 * месяцев (CompensationClosedMonthsError, dormitory-compensation-dates.ts). «Обновление документов» — тоже здесь
 * (updateCompensationDocs): дата не раньше паузы возобновляет компенсацию.
 */
import type { PoolClient } from 'pg';

import { withTransaction } from '../config/postgres.js';
import {
  closedDaysOf,
  closedMonthsChange,
  closedMonthsMessage,
  CompensationClosedMonthsError,
} from './dormitory-compensation-dates.js';
import { readStay, type IDormitoryStay } from './dormitory-stays.service.js';
import { assertApartmentWithoutDormitoryAllowance } from './payroll/payroll-dormitory-allowances.service.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';
import { lockPayrollEmployee } from './payroll/payroll-terms.service.js';

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';

/** Почему не вышло — контроллер отвечает текстом. */
export type CompensationPauseFailure =
  /** Нет записи. */
  | 'not_found'
  /** Не компенсация аренды. */
  | 'not_compensation'
  /** Дата паузы не позже начала записи. */
  | 'before_check_in'
  /** Запись закончилась раньше даты паузы. */
  | 'not_open'
  /** Есть более поздняя компенсация — приостанавливают последнюю. */
  | 'not_latest'
  /** Уже приостановлена с другой даты. */
  | 'already_paused'
  /** Не приостановлена. */
  | 'not_paused'
  /** Дата возобновления раньше паузы. */
  | 'before_pause'
  /** Уже возобновлена с другой даты. */
  | 'already_resumed'
  /** Пересечение с другим проживанием сотрудника (EXCLUDE). */
  | 'overlap';

export interface ICompensationPauseResult {
  /** Запись до изменения (у возобновления — приостановленная). */
  before: IDormitoryStay;
  /** Изменённая запись; у возобновления — новая. */
  after: IDormitoryStay;
  /** Повтор того же запроса — ничего не записано. */
  repeated: boolean;
}

export type CompensationPauseResult = ICompensationPauseResult | CompensationPauseFailure;

/** Компенсация под замком сотрудника: замок — до чтения под FOR UPDATE (порядок, как у правки проживания). */
const lockCompensation = async (client: PoolClient, id: number): Promise<IDormitoryStay | CompensationPauseFailure> => {
  const first = await readStay(client, id, false);
  if (!first) return 'not_found';
  await lockPayrollEmployee(client, first.employee_id);
  const stay = await readStay(client, id, true);
  if (!stay) return 'not_found';
  return stay.kind === 'apartment' ? stay : 'not_compensation';
};

/** Возобновление этой паузы: id и дата начала; нет — null. */
const resumedOf = async (client: PoolClient, id: number): Promise<{ id: number; check_in: string } | null> => (
  (await client.query<{ id: number; check_in: string }>(
    `SELECT id, to_char(check_in, 'YYYY-MM-DD') AS check_in FROM employee_dormitory_stays WHERE resumed_from_id = $1`,
    [id],
  )).rows[0] ?? null
);

const reread = async (client: PoolClient, id: number): Promise<IDormitoryStay> => {
  const stay = await readStay(client, id, false);
  if (!stay) throw new Error('Компенсация не найдена после записи');
  return stay;
};

const run = async <T>(
  work: (client: PoolClient) => Promise<T | CompensationPauseFailure>,
): Promise<T | CompensationPauseFailure> => {
  try {
    return await withTransaction(work);
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'already_resumed';
    throw err;
  }
};

/** Приостановить компенсацию id с даты date (YYYY-MM-DD): с этого дня не начисляется. */
export const suspendCompensation = (
  id: number,
  date: string,
  openFrom: string | null = null,
): Promise<CompensationPauseResult> => run(async client => {
  const stay = await lockCompensation(client, id);
  if (typeof stay === 'string') return stay;
  if (stay.suspended) return stay.check_out === date ? { before: stay, after: stay, repeated: true } : 'already_paused';
  if (date <= stay.check_in) return 'before_check_in';
  if (stay.check_out !== null && stay.check_out < date) return 'not_open';
  const later = (await client.query(
    `SELECT 1 FROM employee_dormitory_stays
      WHERE employee_id = $1 AND kind = 'apartment' AND id <> $2 AND check_in >= $3::date LIMIT 1`,
    [stay.employee_id, stay.id, stay.check_in],
  )).rowCount;
  if (later) return 'not_latest';
  if (openFrom && closedMonthsChange(stay, { check_in: stay.check_in, check_out: date }, openFrom) !== null) {
    throw new CompensationClosedMonthsError(closedMonthsMessage('suspend', openFrom));
  }
  await client.query(
    `UPDATE employee_dormitory_stays SET check_out = $2::date, suspended = true, updated_at = now() WHERE id = $1`,
    [stay.id, date],
  );
  return { before: stay, after: await reread(client, stay.id), repeated: false };
});

/**
 * Новая запись возобновления паузы stay с даты date: ставка, комментарий и «Обновление документов» (docsDate, по
 * умолчанию — прежнее) переносятся.
 */
const insertResumed = async (
  client: PoolClient,
  stay: IDormitoryStay,
  date: string,
  docsDate: string | null,
): Promise<IDormitoryStay> => {
  const opened = (await client.query<{ id: number }>(
    `INSERT INTO employee_dormitory_stays
       (employee_id, kind, check_in, check_out, address, amount, comment, resumed_from_id, docs_updated_on)
     VALUES ($1, 'apartment', $2::date, NULL, $3, $4, $5, $6, $7::date) RETURNING id`,
    [stay.employee_id, date, stay.address, stay.amount, stay.comment, stay.id, docsDate],
  )).rows[0];
  await assertApartmentWithoutDormitoryAllowance(client, stay.employee_id, { check_in: date, check_out: null }, null);
  return reread(client, opened.id);
};

/** Возобновить приостановленную компенсацию id с даты date: новая запись с той же ставкой и комментарием. */
export const resumeCompensation = (
  id: number,
  date: string,
  openFrom: string | null = null,
): Promise<CompensationPauseResult> => run(async client => {
  const stay = await lockCompensation(client, id);
  if (typeof stay === 'string') return stay;
  const resumed = await resumedOf(client, stay.id);
  if (resumed) {
    return resumed.check_in === date
      ? { before: stay, after: await reread(client, resumed.id), repeated: true }
      : 'already_resumed';
  }
  if (!stay.suspended || stay.check_out === null) return 'not_paused';
  if (date < stay.check_out) return 'before_pause';
  if (openFrom && closedDaysOf({ check_in: date, check_out: null }, openFrom) !== null) {
    throw new CompensationClosedMonthsError(closedMonthsMessage('resume', openFrom));
  }
  return { before: stay, after: await insertResumed(client, stay, date, stay.docs_updated_on), repeated: false };
});

/** Завершить паузу: компенсация окончена датой паузы и в следующих месяцах не показывается. */
export const finishCompensationPause = (id: number): Promise<CompensationPauseResult> => run(async client => {
  const stay = await lockCompensation(client, id);
  if (typeof stay === 'string') return stay;
  if (!stay.suspended) return stay.check_out !== null ? { before: stay, after: stay, repeated: true } : 'not_paused';
  if (await resumedOf(client, stay.id)) return 'already_resumed';
  await client.query(`UPDATE employee_dormitory_stays SET suspended = false, updated_at = now() WHERE id = $1`, [stay.id]);
  return { before: stay, after: await reread(client, stay.id), repeated: false };
});

/** «Обновление документов» компенсации: запись до и после, возобновление и снятая будущая пауза (если были). */
export interface ICompensationDocsResult {
  before: IDormitoryStay;
  after: IDormitoryStay;
  /** Дата документов возобновила приостановленную компенсацию — новая запись; нет — null. */
  resumed: IDormitoryStay | null;
  /** Пауза с будущей даты снята — компенсация продолжается без перерыва. */
  pauseCancelled: boolean;
}

/**
 * «Обновление документов» компенсации id (миграция 380): date — дата (null — стереть). Приостановленная и не
 * возобновлённая запись: дата не раньше паузы — компенсация возобновляется с неё, но не раньше открытого периода
 * openFrom (закрытые месяцы не меняются), «Обновление документов» новой записи — эта дата; пауза с будущей даты (позже
 * today) и документы обновлены до неё — пауза снимается (компенсация без перерыва). Без изменений — before = after.
 */
export const updateCompensationDocs = (
  id: number,
  date: string | null,
  openFrom: string,
  today: string,
): Promise<ICompensationDocsResult | CompensationPauseFailure> => run(async client => {
  const stay = await lockCompensation(client, id);
  if (typeof stay === 'string') return stay;
  if (date !== stay.docs_updated_on) {
    await client.query(
      `UPDATE employee_dormitory_stays SET docs_updated_on = $2::date, updated_at = now() WHERE id = $1`,
      [stay.id, date],
    );
  }
  let resumed: IDormitoryStay | null = null;
  let pauseCancelled = false;
  if (date !== null && stay.suspended && stay.check_out !== null && !(await resumedOf(client, stay.id))) {
    if (date >= stay.check_out) {
      resumed = await insertResumed(client, stay, date > openFrom ? date : openFrom, date);
    } else if (stay.check_out > today) {
      await client.query(
        `UPDATE employee_dormitory_stays SET check_out = NULL, suspended = false, updated_at = now() WHERE id = $1`,
        [stay.id],
      );
      await assertApartmentWithoutDormitoryAllowance(
        client, stay.employee_id, { check_in: stay.check_in, check_out: null }, stay,
      );
      pauseCancelled = true;
    }
  }
  return { before: stay, after: await reread(client, stay.id), resumed, pauseCancelled };
});

