/**
 * «Переселить» (вкладки «Общежитие» и «Квартира» «Проживания», миграция 371): сотрудник с даты живёт в другом
 * общежитии или служебной квартире. Одна транзакция под lockPayrollEmployee (тот же замок, что у доплат «Зарплаты»):
 * текущему проживанию — выезд в дату переселения, новое — с этой даты до прежнего выезда (обычно открытое). Прежняя
 * запись остаётся в истории; адрес не правится UPDATE-ом.
 *
 * Деньги не меняются: переселяют только между общежитием и служебной квартирой (оба — вид dormitory, оба одинаково
 * снимают авто-доплату за общежитие), компенсация аренды — отдельно. «Платно» новой записи сбрасывается (другое жильё),
 * комментарий — присланный, иначе переносится прежний.
 *
 * Повтор того же запроса (двойной клик, обрыв связи) — та же пара записей без изменений (repeated): прежняя уже
 * закрыта этой датой, а у сотрудника есть запись с въездом в эту дату в том же месте.
 */
import type { PoolClient } from 'pg';

import { withTransaction } from '../config/postgres.js';
import { resolveDormitoryName } from './dormitory-directory.service.js';
import { getStay, type IDormitoryStay } from './dormitory-stays.service.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';
import { lockPayrollEmployee } from './payroll/payroll-terms.service.js';

const PG_EXCLUSION_VIOLATION = '23P01';

/** Куда переселить: общежитие (адрес) или служебная квартира (id). */
export type StayMoveTarget = { address: string } | { apartmentId: number };

/** Почему не переселили — контроллер отвечает текстом. */
export type StayMoveFailure =
  /** Нет записи. */
  | 'not_found'
  /** Компенсацию аренды не переселяют. */
  | 'not_movable'
  /** Квартиры нет. */
  | 'apartment_not_found'
  /** Общежития нет в справочнике (миграция 377). */
  | 'not_in_directory'
  /** Сотрудник уже живёт там же. */
  | 'same_place'
  /** Дата не позже въезда. */
  | 'before_check_in'
  /** В дату переселения запись уже не действует (выехал раньше). */
  | 'not_open'
  /** Пересечение с другим проживанием сотрудника (EXCLUDE). */
  | 'overlap';

export type StayMoveResult = { closed: IDormitoryStay; opened: IDormitoryStay; repeated: boolean } | StayMoveFailure;

interface IPlace {
  apartment_id: number | null;
  address: string;
}

/** Адрес и ссылка новой записи: у общежития — название справочника, у квартиры — копия «Кв. <адрес>». */
const resolvePlace = async (client: PoolClient, target: StayMoveTarget): Promise<IPlace | 'not_in_directory' | null> => {
  if ('address' in target) {
    const name = await resolveDormitoryName(client, target.address);
    return name === null ? 'not_in_directory' : { apartment_id: null, address: name };
  }
  const row = (await client.query<{ id: number; address: string }>(
    `SELECT id, address FROM company_apartments WHERE id = $1 FOR SHARE`,
    [target.apartmentId],
  )).rows[0];
  return row ? { apartment_id: row.id, address: `Кв. ${row.address}` } : null;
};

const samePlace = (stay: { apartment_id: number | null; address: string | null }, place: IPlace): boolean => (
  place.apartment_id !== null
    ? stay.apartment_id === place.apartment_id
    : stay.apartment_id === null && (stay.address ?? '').trim().toLowerCase() === place.address.trim().toLowerCase()
);

const STAY_ROW_SQL = `SELECT id, employee_id, kind, apartment_id, address, comment,
                             to_char(check_in, 'YYYY-MM-DD') AS check_in,
                             to_char(check_out, 'YYYY-MM-DD') AS check_out
                        FROM employee_dormitory_stays`;

interface IStayRow {
  id: number;
  employee_id: number;
  kind: string;
  apartment_id: number | null;
  address: string | null;
  comment: string | null;
  check_in: string;
  check_out: string | null;
}

/**
 * Переселить проживание id с даты date (YYYY-MM-DD) в target. Окно даты (с 1-го числа текущего месяца по сегодня)
 * проверяет контроллер; здесь — правила записи.
 */
export const moveStay = async (
  id: number,
  date: string,
  target: StayMoveTarget,
  comment: string | null = null,
): Promise<StayMoveResult> => {
  try {
    const ids = await withTransaction(async (client): Promise<{ closedId: number; openedId: number; repeated: boolean } | StayMoveFailure> => {
      const first = (await client.query<IStayRow>(`${STAY_ROW_SQL} WHERE id = $1`, [id])).rows[0];
      if (!first) return 'not_found';
      // Замок сотрудника — до чтения под FOR UPDATE: тот же порядок, что у правки проживания и доплат «Зарплаты».
      await lockPayrollEmployee(client, first.employee_id);
      const current = (await client.query<IStayRow>(`${STAY_ROW_SQL} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!current) return 'not_found';
      if (current.kind !== 'dormitory') return 'not_movable';
      const place = await resolvePlace(client, target);
      if (place === 'not_in_directory') return place;
      if (!place) return 'apartment_not_found';

      // Повтор: прежняя закрыта этой датой, следующая — с этой даты в том же месте.
      if (current.check_out === date) {
        const next = (await client.query<IStayRow>(
          `${STAY_ROW_SQL} WHERE employee_id = $1 AND check_in = $2::date AND kind = 'dormitory'`,
          [current.employee_id, date],
        )).rows[0];
        if (next && samePlace(next, place)) return { closedId: current.id, openedId: next.id, repeated: true };
        return 'not_open';
      }
      if (date <= current.check_in) return 'before_check_in';
      if (current.check_out !== null && current.check_out < date) return 'not_open';
      if (samePlace(current, place)) return 'same_place';

      await client.query(
        `UPDATE employee_dormitory_stays SET check_out = $2::date, updated_at = now() WHERE id = $1`,
        [current.id, date],
      );
      const opened = (await client.query<{ id: number }>(
        `INSERT INTO employee_dormitory_stays (employee_id, kind, check_in, check_out, address, amount, apartment_id, paid, comment)
         VALUES ($1, 'dormitory', $2::date, $3::date, $4, NULL, $5, false, $6) RETURNING id`,
        [current.employee_id, date, current.check_out, place.address, place.apartment_id, comment ?? current.comment],
      )).rows[0];
      return { closedId: current.id, openedId: opened.id, repeated: false };
    });
    if (typeof ids === 'string') return ids;
    const [closed, opened] = await Promise.all([getStay(ids.closedId), getStay(ids.openedId)]);
    if (!closed || !opened) return 'not_found';
    return { closed, opened, repeated: ids.repeated };
  } catch (err) {
    if (hasPgCode(err, PG_EXCLUSION_VIOLATION)) return 'overlap';
    throw err;
  }
};
