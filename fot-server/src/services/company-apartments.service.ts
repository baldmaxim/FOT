/**
 * Служебные квартиры компании (миграция 371) — «Управление кадрами» → «Проживание» → «Квартира», как «Учёт квартир»
 * 1С: адрес, пометка («РФ \ ВНЖ», «семейная»), комнат, мест (справочно, не лимит), цена аренды ₽/мес, «оплачено по».
 *
 * Жильцы — employee_dormitory_stays вида dormitory с apartment_id (STAY_CLASS_SQL.flat). Адрес квартиры — источник;
 * в проживании хранится копия «Кв. <адрес>» (её читает «Справочник → Общежитие» «Зарплаты»): правка адреса квартиры
 * переписывает копии всех её проживаний в той же транзакции. Квартиру с проживаниями (и прошлыми) не удалить —
 * история жильцов пропала бы (FK ON DELETE RESTRICT).
 */
import { query, withTransaction } from '../config/postgres.js';
import { hasPgCode } from './payroll/payroll-pg-errors.js';

/** Уникальный адрес (без учёта регистра и пробелов по краям). */
const PG_UNIQUE_VIOLATION = '23505';

export interface ICompanyApartment {
  id: number;
  address: string;
  note: string | null;
  rooms: number | null;
  places: number | null;
  /** Аренда ₽/мес, numeric строкой. */
  price: string | null;
  /** YYYY-MM-DD. */
  paid_until: string | null;
}

export interface ICompanyApartmentFields {
  address: string;
  note: string | null;
  rooms: number | null;
  places: number | null;
  price: number | null;
  paid_until: string | null;
}

const APARTMENT_SELECT = `
  SELECT a.id, a.address, a.note, a.rooms, a.places, a.price::text AS price,
         to_char(a.paid_until, 'YYYY-MM-DD') AS paid_until
    FROM company_apartments a`;

/** Все квартиры в порядке адреса. */
export const listApartments = async (): Promise<ICompanyApartment[]> =>
  query<ICompanyApartment>(`${APARTMENT_SELECT} ORDER BY a.address, a.id`);

export const getApartment = async (id: number): Promise<ICompanyApartment | null> =>
  (await query<ICompanyApartment>(`${APARTMENT_SELECT} WHERE a.id = $1`, [id]))[0] ?? null;

/** Добавить квартиру; такой адрес уже есть — 'duplicate'. */
export const addApartment = async (fields: ICompanyApartmentFields): Promise<ICompanyApartment | 'duplicate'> => {
  try {
    const row = (await query<{ id: number }>(
      `INSERT INTO company_apartments (address, note, rooms, places, price, paid_until)
       VALUES ($1, $2, $3, $4, $5, $6::date) RETURNING id`,
      [fields.address, fields.note, fields.rooms, fields.places, fields.price, fields.paid_until],
    ))[0];
    const added = await getApartment(row.id);
    if (!added) throw new Error('Квартира не найдена после добавления');
    return added;
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/**
 * Изменить квартиру. Новый адрес переписывает копию «Кв. <адрес>» у всех её проживаний (relinked — сколько).
 * Нет квартиры — null; адрес занят другой — 'duplicate'.
 */
export const updateApartment = async (
  id: number,
  fields: ICompanyApartmentFields,
): Promise<{ before: ICompanyApartment; after: ICompanyApartment; relinked: number } | 'duplicate' | null> => {
  try {
    return await withTransaction(async client => {
      const before = (await client.query<ICompanyApartment>(`${APARTMENT_SELECT} WHERE a.id = $1 FOR UPDATE`, [id])).rows[0];
      if (!before) return null;
      await client.query(
        `UPDATE company_apartments
            SET address = $2, note = $3, rooms = $4, places = $5, price = $6, paid_until = $7::date, updated_at = now()
          WHERE id = $1`,
        [id, fields.address, fields.note, fields.rooms, fields.places, fields.price, fields.paid_until],
      );
      let relinked = 0;
      if (before.address !== fields.address) {
        relinked = (await client.query(
          `UPDATE employee_dormitory_stays SET address = 'Кв. ' || $2, updated_at = now()
            WHERE apartment_id = $1 AND address IS DISTINCT FROM 'Кв. ' || $2`,
          [id, fields.address],
        )).rowCount ?? 0;
      }
      const after = (await client.query<ICompanyApartment>(`${APARTMENT_SELECT} WHERE a.id = $1`, [id])).rows[0];
      return { before, after, relinked };
    });
  } catch (err) {
    if (hasPgCode(err, PG_UNIQUE_VIOLATION)) return 'duplicate';
    throw err;
  }
};

/** Удалить квартиру без проживаний (и прошлых); есть — 'has_stays'; нет квартиры — null. */
export const deleteApartment = async (id: number): Promise<ICompanyApartment | 'has_stays' | null> =>
  withTransaction(async client => {
    const before = (await client.query<ICompanyApartment>(`${APARTMENT_SELECT} WHERE a.id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) return null;
    const used = (await client.query(`SELECT 1 FROM employee_dormitory_stays WHERE apartment_id = $1 LIMIT 1`, [id])).rows.length > 0;
    if (used) return 'has_stays';
    await client.query(`DELETE FROM company_apartments WHERE id = $1`, [id]);
    return before;
  });
