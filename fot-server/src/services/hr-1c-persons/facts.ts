/**
 * Факты из БД для сопоставления одного физлица 1С. Одни и те же запросы — в предпросмотре
 * (пул) и при записи (клиент транзакции после FOR UPDATE карточки), поэтому решение под
 * блокировкой считается по свежим данным.
 */
import { hashForSearch, normalizeNameForHash } from '../hr-crypto.service.js';
import type { IPerson1c } from './parse.js';
import type { IClaimOwner, IFotCard, IPersonFacts, IPersonHashes, IPersonKeys, Signal } from './match.js';

export interface IDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const personHashes = (p: IPerson1c): IPersonHashes => ({
  snils: hashForSearch('snils', p.snils),
  inn: hashForSearch('inn', p.inn),
  passport: p.passport ? hashForSearch('passport', p.passport.number) : null,
  kig: hashForSearch('kig', p.kig),
});

export const personKeys = (p: IPerson1c): IPersonKeys => ({
  idAll: p.idAll,
  nameKey: normalizeNameForHash(p.fullName) ?? '',
  birthDate: p.birthDate,
  snils: p.snils,
  departments: p.departments,
  keyConflict: p.keyConflict,
  hashes: personHashes(p),
});

const PAYOUT_LINK = `resolution IN ('auto_id_fot', 'auto_id_all', 'confirmed') AND employee_id IS NOT NULL AND person_id_all IS NOT NULL`;

/** Карточки, связанные с этим id_all (выплаты 1С, больничные, профиль). */
const LINKED_BY_ID_ALL_SQL = `
  SELECT employee_id FROM payroll_1c_payout_lines WHERE ${PAYOUT_LINK} AND person_id_all = $1::uuid
  UNION SELECT employee_id FROM payroll_fss_payments WHERE employee_id IS NOT NULL AND person_id_all = $1::uuid
  UNION SELECT employee_id FROM employee_hr_profiles WHERE passdesk_id_all = $1::uuid`;

/** Все id_all, с которыми связаны карточки. */
const ID_ALLS_OF_CARDS_SQL = `
  SELECT employee_id, person_id_all::text AS id_all FROM payroll_1c_payout_lines WHERE ${PAYOUT_LINK} AND employee_id = ANY($1::int[])
  UNION SELECT employee_id, person_id_all::text FROM payroll_fss_payments
         WHERE employee_id = ANY($1::int[]) AND person_id_all IS NOT NULL
  UNION SELECT employee_id, passdesk_id_all::text FROM employee_hr_profiles
         WHERE employee_id = ANY($1::int[]) AND passdesk_id_all IS NOT NULL`;

const NAME_EXPR = `lower(btrim(regexp_replace(translate(e.full_name, 'Ёё', 'Ее'), '\\s+', ' ', 'g')))`;

const ids = (rows: Array<{ id: number | string }>): number[] => rows.map(r => Number(r.id));

const isWorking = (r: { employment_status: string | null; is_archived: boolean | null; dismissal_date: string | null }, asOf: string): boolean =>
  r.employment_status === 'active' && !r.is_archived && (!r.dismissal_date || r.dismissal_date > asOf);

/**
 * Все сильные признаки и однофамильцы — одним запросом (по сети каждый запрос дорог):
 * строка = (признак, карточка, её ДР). Пустой параметр признака отключает его ветку.
 */
const SIGNALS_SQL = `
  SELECT 'id_all' AS s, x.employee_id AS id, NULL::text AS birth_date FROM (${LINKED_BY_ID_ALL_SQL}) x
  UNION ALL
  SELECT 'snils', e.id, NULL FROM employees e
   WHERE $2::text IS NOT NULL AND regexp_replace(COALESCE(e.pension_number, ''), '\\D', '', 'g') = $2
  UNION ALL SELECT 'snils', employee_id, NULL FROM employee_hr_profiles WHERE snils_hash = $3
  UNION ALL SELECT 'snils', employee_id, NULL FROM hr_identity_claims WHERE claim_type = 'snils' AND claim_hash = $3 AND employee_id IS NOT NULL
  UNION ALL SELECT 'inn', employee_id, NULL FROM employee_hr_profiles WHERE inn_hash = $4
  UNION ALL SELECT 'inn', employee_id, NULL FROM hr_identity_claims WHERE claim_type = 'inn' AND claim_hash = $4 AND employee_id IS NOT NULL
  UNION ALL SELECT 'passport', employee_id, NULL FROM employee_hr_profiles WHERE passport_number_hash = $5
  UNION ALL SELECT 'passport', employee_id, NULL FROM hr_identity_claims WHERE claim_type = 'passport' AND claim_hash = $5 AND employee_id IS NOT NULL
  UNION ALL SELECT 'kig', employee_id, NULL FROM employee_hr_profiles WHERE kig_hash = $6
  UNION ALL SELECT 'name', e.id, e.birth_date::text FROM employees e WHERE $7::text IS NOT NULL AND ${NAME_EXPR} = $7`;

export const loadPersonFacts = async (db: IDb, person: IPerson1c, keys: IPersonKeys, asOf: string, extraIds: number[] = []): Promise<IPersonFacts> => {
  const h = keys.hashes;
  const bySignal: Record<Signal, number[]> = { id_all: [], snils: [], inn: [], passport: [], kig: [], name_birth: [] };
  const nameKey = normalizeNameForHash(person.fullName);
  const signalRows = (await db.query<{ s: Signal | 'name'; id: number; birth_date: string | null }>(
    SIGNALS_SQL, [person.idAll, person.snils, h.snils, h.inn, h.passport, h.kig, nameKey])).rows;
  const byNameRows = signalRows.filter(r => r.s === 'name');
  for (const r of signalRows) if (r.s !== 'name') bySignal[r.s].push(Number(r.id));
  for (const k of Object.keys(bySignal) as Signal[]) bySignal[k] = [...new Set(bySignal[k])];
  const byName = [...new Set(ids(byNameRows))];
  if (person.birthDate) bySignal.name_birth = [...new Set(ids(byNameRows.filter(r => r.birth_date === person.birthDate)))];

  const claimRows = (await db.query<{ claim_type: IClaimOwner['claimType']; employee_id: number | null; draft_id: string | null }>(
    `SELECT claim_type, employee_id, draft_id::text AS draft_id FROM hr_identity_claims
      WHERE (claim_type = 'snils' AND claim_hash = $1) OR (claim_type = 'inn' AND claim_hash = $2) OR (claim_type = 'passport' AND claim_hash = $3)`,
    [h.snils, h.inn, h.passport],
  )).rows;
  const claims: IClaimOwner[] = claimRows.map(r => ({ claimType: r.claim_type, employeeId: r.employee_id === null ? null : Number(r.employee_id), draftId: r.draft_id }));

  const allIds = [...new Set([...Object.values(bySignal).flat(), ...byName, ...extraIds])];
  const cards = new Map<number, IFotCard>();
  if (allIds.length > 0) {
    const rows = (await db.query<{
      id: number; full_name: string; department: string | null; birth_date: string | null; pension_number: string | null;
      employment_status: string | null; dismissal_date: string | null; is_archived: boolean | null; has_profile: boolean;
      passdesk_id_all: string | null; snils_hash: string | null; inn_hash: string | null; passport_number_hash: string | null; kig_hash: string | null;
    }>(
      `SELECT e.id, e.full_name, d.name AS department, e.birth_date::text AS birth_date, e.pension_number, e.employment_status,
              e.dismissal_date::text AS dismissal_date, e.is_archived, (p.employee_id IS NOT NULL) AS has_profile,
              p.passdesk_id_all::text AS passdesk_id_all, p.snils_hash, p.inn_hash, p.passport_number_hash, p.kig_hash
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN employee_hr_profiles p ON p.employee_id = e.id
        WHERE e.id = ANY($1::int[])`, [allIds])).rows;
    const links = (await db.query<{ employee_id: number; id_all: string }>(ID_ALLS_OF_CARDS_SQL, [allIds])).rows;
    for (const r of rows) {
      const id = Number(r.id);
      const snils = (r.pension_number ?? '').replace(/\D/g, '');
      cards.set(id, {
        id,
        fullName: r.full_name,
        department: r.department,
        working: isWorking(r, asOf),
        birthDate: r.birth_date,
        snilsDigits: snils || null,
        hasProfile: r.has_profile,
        passdeskIdAll: r.passdesk_id_all,
        snilsHash: r.snils_hash?.trim() || null,
        innHash: r.inn_hash?.trim() || null,
        passportHash: r.passport_number_hash?.trim() || null,
        kigHash: r.kig_hash?.trim() || null,
        linkedIdAlls: [...new Set(links.filter(l => Number(l.employee_id) === id).map(l => l.id_all))],
      });
    }
  }
  return { cards, bySignal, byName, claims };
};
