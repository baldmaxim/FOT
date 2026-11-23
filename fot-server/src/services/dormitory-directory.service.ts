/**
 * Справочник общежитий (миграции 319, 377) — «Управление кадрами» → «Проживание» → «Общежитие» → «Справочник», как
 * «Общежития» 1С: Дата, Номер, Общежитие (название / адрес), Стоимость места (₽, только для информации — в расчётах
 * «Зарплаты» не участвует). Таблица — dormitory_addresses, название уникально без учёта регистра.
 *
 * Название — ключ: у записей общежития (STAY_CLASS_SQL.dormitory) хранится то же название. Заселение и переселение
 * принимают только название из справочника (resolveDormitoryName, FOR SHARE — переименование дождётся записи);
 * переименование переписывает название у всех записей общежития в той же транзакции (FOR UPDATE — заселение по
 * прежнему названию дождётся и получит отказ). Общежитие с записями (и прошлыми) не удалить — история пропала бы.
 */
import type { PoolClient } from 'pg';

import { query, withTransaction } from '../config/postgres.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';

/** Уникальное название (без учёта регистра и пробелов по краям, индекс миграции 319). */
const PG_UNIQUE_VIOLATION = '23505';

export interface IDormitory {
  id: number;
  /** Общежитие — название / адрес. */
  address: string;
  /** «Дата» — YYYY-MM-DD. */
  doc_date: string | null;
  /** «Номер» — как в 1С. */
  doc_number: string | null;
  /** «Стоимость места», ₽, numeric строкой. */
  place_price: string | null;
}

export interface IDormitoryFields {
  address: string;
  doc_date: string | null;
  doc_number: string | null;
  place_price: number | null;
}

const DORMITORY_SELECT = `
  SELECT d.id, d.address, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date, d.doc_number, d.place_price::text AS place_price
    FROM dormitory_addresses d`;

/** Записи общежития с этим названием (без учёта регистра): служебные квартиры и компенсации — не общежитие. */
const STAYS_OF_NAME_SQL = `kind = 'dormitory' AND apartment_id IS NULL AND lower(btrim(address)) = lower(btrim($1))`;

/** Все общежития в порядке названия. */
export const listDormitories = async (): Promise<IDormitory[]> =>
  query<IDormitory>(`${DORMITORY_SELECT} ORDER BY d.address, d.id`);

export const getDormitory = async (id: number): Promise<IDormitory | null> =>
  (await query<IDormitory>(`${DORMITORY_SELECT} WHERE d.id = $1`, [id]))[0] ?? null;

/**
 * Название общежития из справочника для записи проживания (написание справочника) или null — такого нет. FOR SHARE:
 * переименование и удаление этого общежития дождутся конца транзакции записи.
 */
export const resolveDormitoryName = async (client: PoolClient, address: string | null): Promise<string | null> => {
  if (!address || !address.trim()) return null;
  return (await client.query<{ address: string }>(
    `SELECT address FROM dormitory_addresses WHERE lower(btrim(address)) = lower(btrim($1)) FOR SHARE`,
    [address],
  )).rows[0]?.address ?? null;
};

/** Общежития нет в справочнике — запись проживания не принимается (ответ 400). */
export class DormitoryNotInDirectoryError extends Error {
  readonly code = 'DORMITORY_NOT_IN_DIRECTORY';

  constructor() {
    super('Выберите общежитие из справочника («Общежитие» → «Справочник»)');
    this.name = 'DormitoryNotInDirectoryError';
  }
}

/** Добавить общежитие; такое название уже есть — 'duplicate'. */
export const addDormitory = async (fields: IDormitoryFields): Promise<IDormitory | 'duplicate'> => {
  try {
    const row = (await query<{ id: number }>(
      `INSERT INTO dormitory_addresses (address, doc_date, doc_number, place_price)
       VALUES ($1, $2::date, $3, $4) RETURNING id`,
      [fields.address, fields.doc_date, fields.doc_number, fields.place_price],
    ))[0];
    const added = await getDormitory(row.id);
    if (!added) throw new Error('Общежитие не найдено после добавления');
    return added;
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/**
 * Изменить общежитие. Новое название переписывает название у всех записей общежития с прежним (readdressed — сколько).
 * Нет общежития — null; название занято другим — 'duplicate'.
 */
export const updateDormitory = async (
  id: number,
  fields: IDormitoryFields,
): Promise<{ before: IDormitory; after: IDormitory; readdressed: number } | 'duplicate' | null> => {
  try {
    return await withTransaction(async client => {
      const before = (await client.query<IDormitory>(`${DORMITORY_SELECT} WHERE d.id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) return null;
      await client.query(
        `UPDATE dormitory_addresses
            SET address = $2, doc_date = $3::date, doc_number = $4, place_price = $5, updated_at = now()
          WHERE id = $1`,
        [id, fields.address, fields.doc_date, fields.doc_number, fields.place_price],
      );
      let readdressed = 0;
      if (before.address !== fields.address) {
        readdressed = (await client.query(
          `UPDATE employee_dormitory_stays SET address = $2, updated_at = now()
            WHERE ${STAYS_OF_NAME_SQL} AND address IS DISTINCT FROM $2`,
          [before.address, fields.address],
        )).rowCount ?? 0;
      }
      const after = (await client.query<IDormitory>(`${DORMITORY_SELECT} WHERE d.id = $1`, [id])).rows[0];
      return { before, after, readdressed };
    });
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить общежитие без записей (и прошлых); есть — 'has_stays'; нет общежития — null. */
export const deleteDormitory = async (id: number): Promise<IDormitory | 'has_stays' | null> =>
  withTransaction(async client => {
    const before = (await client.query<IDormitory>(`${DORMITORY_SELECT} WHERE d.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) return null;
    const used = (await client.query(
      `SELECT 1 FROM employee_dormitory_stays WHERE ${STAYS_OF_NAME_SQL} LIMIT 1`,
      [before.address],
    )).rows.length > 0;
    if (used) return 'has_stays';
    await client.query(`DELETE FROM dormitory_addresses WHERE id = $1`, [id]);
    return before;
  });
