/**
 * «Проживание» → «Общежитие» → «История взысканий» (миграция 378, решения пользователя 24.11.2026): отдельный список
 * сотрудников со взысканиями (дата и/или информация; позже — загрузка скриптом, source 'import') и действующие записи
 * «Чёрного списка» пропусков (person_blacklist, миграция 273) — их ведут в «Системе», здесь только чтение. Окно
 * «Заселить» по penaltyMatches предупреждает (заселить можно); пометка в подсказке поиска — из той же проверки.
 */
import { query, queryOne } from '../config/postgres.js';
import { findActive } from './blacklist.service.js';

export type DormitoryPenaltySource = 'list' | 'blacklist';

/** Строка «Истории взысканий». */
export interface IDormitoryPenaltyRow {
  /** Ключ строки: 'p<id>' — запись списка, 'b<uuid>' — запись «Чёрного списка». */
  key: string;
  /** id записи списка; у «Чёрного списка» — null (правят в «Системе»). */
  id: number | null;
  source: DormitoryPenaltySource;
  /** Карточка; запись «Чёрного списка» без связи с карточкой — null (ФИО записи). */
  employee_id: number | null;
  full_name: string;
  department: string | null;
  employment_status: string | null;
  /** YYYY-MM-DD; работает — null. */
  dismissal_date: string | null;
  /** YYYY-MM-DD; у «Чёрного списка» — дата внесения (МСК). */
  penalty_date: string | null;
  /** Информация; у «Чёрного списка» — причина. */
  note: string | null;
}

/** Запись списка. */
export interface IDormitoryPenalty {
  id: number;
  employee_id: number;
  penalty_date: string | null;
  note: string | null;
  source: 'manual' | 'import';
}

export interface IDormitoryPenaltyInput {
  penalty_date: string | null;
  note: string | null;
}

/** «Есть взыскания» — та же карточка, тот же человек или надёжный ключ «Чёрного списка»; «Проверьте» — только ФИО. */
export type PenaltyLevel = 'yes' | 'check';

export interface IPenaltyMatchItem {
  source: DormitoryPenaltySource;
  level: PenaltyLevel;
  /** Чья запись: ФИО карточки списка или записи «Чёрного списка». */
  full_name: string;
  penalty_date: string | null;
  note: string | null;
}

export interface IPenaltyMatch {
  level: PenaltyLevel | null;
  items: IPenaltyMatchItem[];
}

const NO_MATCH: IPenaltyMatch = { level: null, items: [] };

const PENALTY_SELECT = `
  SELECT p.id, p.employee_id, to_char(p.penalty_date, 'YYYY-MM-DD') AS penalty_date, p.note, p.source
    FROM dormitory_penalties p`;

/**
 * Связи записей «Чёрного списка» с карточками: прямая (person_blacklist.employee_id, приоритет 0) и цели блокировки
 * (person_blacklist_targets.employee_id, приоритет 1). Только действующие записи.
 */
const BLACKLIST_LINKS_CTE = `
  blacklist_links AS (
    SELECT b.id AS blacklist_id, b.employee_id::int AS employee_id, 0 AS priority
      FROM person_blacklist b
     WHERE b.removed_at IS NULL AND b.employee_id IS NOT NULL
    UNION ALL
    SELECT t.blacklist_id, t.employee_id::int, 1
      FROM person_blacklist_targets t
      JOIN person_blacklist b ON b.id = t.blacklist_id
     WHERE b.removed_at IS NULL AND t.employee_id IS NOT NULL
  )`;

/**
 * «История взысканий» в охвате employeeIds (null — вся организация, пустой — пустой ответ):
 * - записи списка — по карточке в охвате;
 * - запись «Чёрного списка» — одна строка: карточка связи в охвате (сначала прямая, иначе цель с самым поздним
 *   приёмом); связанная, но вне охвата — не видна; без единой связи — только при охвате «вся организация», с ФИО записи.
 * Порядок — дата, новые сверху (без даты — в конце).
 */
export const listPenalties = async (employeeIds: number[] | null): Promise<IDormitoryPenaltyRow[]> => {
  if (employeeIds?.length === 0) return [];
  const rows = await query<IDormitoryPenaltyRow & { sort_id: string }>(
    `WITH ${BLACKLIST_LINKS_CTE},
     scoped_links AS (
       SELECT DISTINCT ON (l.blacklist_id) l.blacklist_id, l.employee_id
         FROM blacklist_links l
         JOIN employees e ON e.id = l.employee_id
        WHERE $1::int[] IS NULL OR l.employee_id = ANY($1::int[])
        ORDER BY l.blacklist_id, l.priority, e.hire_date DESC NULLS LAST, e.id DESC
     )
     SELECT 'p' || p.id AS key, p.id, 'list' AS source, p.employee_id, e.full_name, d.name AS department,
            e.employment_status, to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date,
            to_char(p.penalty_date, 'YYYY-MM-DD') AS penalty_date, p.note,
            lpad(p.id::text, 12, '0') AS sort_id
       FROM dormitory_penalties p
       JOIN employees e ON e.id = p.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE $1::int[] IS NULL OR p.employee_id = ANY($1::int[])
     UNION ALL
     SELECT 'b' || b.id::text, NULL, 'blacklist', s.employee_id, COALESCE(e.full_name, b.full_name), d.name,
            e.employment_status, to_char(e.dismissal_date, 'YYYY-MM-DD'),
            to_char(b.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD'), b.reason,
            b.id::text
       FROM person_blacklist b
       LEFT JOIN scoped_links s ON s.blacklist_id = b.id
       LEFT JOIN employees e ON e.id = s.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE b.removed_at IS NULL
        AND (s.employee_id IS NOT NULL
             OR ($1::int[] IS NULL AND NOT EXISTS (SELECT 1 FROM blacklist_links l WHERE l.blacklist_id = b.id)))
      ORDER BY penalty_date DESC NULLS LAST, sort_id DESC`,
    [employeeIds],
  );
  return rows.map(({ sort_id: _sortId, ...row }) => row);
};

interface ICardForMatch {
  id: number;
  full_name: string;
  birth_date: string | null;
  pension_number: string | null;
  email: string | null;
}

/** Сильнейший уровень: «Есть» важнее «Проверьте». */
const stronger = (a: PenaltyLevel | null, b: PenaltyLevel): PenaltyLevel => (a === 'yes' || b === 'yes' ? 'yes' : 'check');

/**
 * Взыскания сотрудников для окна «Заселить» и пометки в поиске — одна проверка на оба места:
 * - запись списка этой карточки → «Есть»;
 * - запись другой карточки с тем же ФИО (norm_person_name) и обеими непустыми равными датами рождения → «Есть»
 *   (переоформленный человек); совпало только ФИО (или дата пустая у кого-то) → «Проверьте»: две пустые даты — не
 *   один человек;
 * - «Чёрный список»: прямая связь или цель блокировки — эта карточка → «Есть»; findActive (ФИО, ДР, СНИЛС, e-mail
 *   карточки) — strong → «Есть», weak (только ФИО) → «Проверьте».
 * Совпадения — по записи один раз, с сильнейшим уровнем; итог — сильнейший уровень. Нет — в Map нет ключа.
 */
export const penaltyMatches = async (employeeIds: number[]): Promise<Map<number, IPenaltyMatch>> => {
  const result = new Map<number, IPenaltyMatch>();
  if (employeeIds.length === 0) return result;
  const found = new Map<number, Map<string, IPenaltyMatchItem>>();
  const add = (employeeId: number, key: string, item: IPenaltyMatchItem) => {
    const items = found.get(employeeId) ?? new Map<string, IPenaltyMatchItem>();
    const prev = items.get(key);
    items.set(key, prev ? { ...prev, level: stronger(prev.level, item.level) } : item);
    found.set(employeeId, items);
  };

  const listRows = await query<{
    candidate_id: number; penalty_id: number; level: PenaltyLevel; full_name: string; penalty_date: string | null; note: string | null;
  }>(
    `SELECT c.id AS candidate_id, p.id AS penalty_id, e.full_name,
            to_char(p.penalty_date, 'YYYY-MM-DD') AS penalty_date, p.note,
            CASE WHEN e.id = c.id
                   OR (c.birth_date IS NOT NULL AND e.birth_date IS NOT NULL AND c.birth_date = e.birth_date)
                 THEN 'yes' ELSE 'check' END AS level
       FROM dormitory_penalties p
       JOIN employees e ON e.id = p.employee_id
       JOIN employees c ON c.id = ANY($1::int[])
                       AND (c.id = e.id OR public.norm_person_name(c.full_name) = public.norm_person_name(e.full_name))`,
    [employeeIds],
  );
  for (const row of listRows) {
    add(row.candidate_id, `p${row.penalty_id}`, {
      source: 'list', level: row.level, full_name: row.full_name, penalty_date: row.penalty_date, note: row.note,
    });
  }

  // «Чёрный список» пуст (как на проде 24.11.2026) — без запросов по каждому кандидату.
  const blacklistActive = await queryOne<{ any: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM person_blacklist WHERE removed_at IS NULL) AS any`,
  );
  if (blacklistActive?.any) {
    const linked = await query<{ candidate_id: number; blacklist_id: string; full_name: string; created: string; reason: string }>(
      `WITH ${BLACKLIST_LINKS_CTE}
       SELECT DISTINCT l.employee_id AS candidate_id, b.id::text AS blacklist_id, b.full_name, b.reason,
              to_char(b.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS created
         FROM blacklist_links l
         JOIN person_blacklist b ON b.id = l.blacklist_id
        WHERE l.employee_id = ANY($1::int[])`,
      [employeeIds],
    );
    for (const row of linked) {
      add(row.candidate_id, `b${row.blacklist_id}`, {
        source: 'blacklist', level: 'yes', full_name: row.full_name, penalty_date: row.created, note: row.reason,
      });
    }
    const cards = await query<ICardForMatch>(
      `SELECT e.id, e.full_name, to_char(e.birth_date, 'YYYY-MM-DD') AS birth_date, e.pension_number, e.email
         FROM employees e WHERE e.id = ANY($1::int[])`,
      [employeeIds],
    );
    for (const card of cards) {
      const matches = await findActive({
        employeeId: card.id,
        fullName: card.full_name,
        birthDate: card.birth_date,
        snils: card.pension_number,
        email: card.email,
      });
      for (const [level, entries] of [['yes', matches.strong], ['check', matches.weak]] as const) {
        for (const entry of entries) {
          add(card.id, `b${entry.id}`, {
            source: 'blacklist', level, full_name: entry.full_name, penalty_date: entry.created_at.slice(0, 10), note: entry.reason,
          });
        }
      }
    }
  }

  for (const [employeeId, items] of found) {
    const list = [...items.values()].sort((a, b) => (
      (a.level === b.level ? 0 : a.level === 'yes' ? -1 : 1)
      || (b.penalty_date ?? '').localeCompare(a.penalty_date ?? '')
    ));
    result.set(employeeId, { level: list.some(item => item.level === 'yes') ? 'yes' : 'check', items: list });
  }
  return result;
};

/** Проверка одного сотрудника; нет взысканий — пустой ответ. */
export const penaltyMatchOf = async (employeeId: number): Promise<IPenaltyMatch> => (
  (await penaltyMatches([employeeId])).get(employeeId) ?? NO_MATCH
);

export const getPenalty = async (id: number): Promise<IDormitoryPenalty | null> =>
  queryOne<IDormitoryPenalty>(`${PENALTY_SELECT} WHERE p.id = $1`, [id]);

const PENALTY_RETURNING = `RETURNING p.id, p.employee_id, to_char(p.penalty_date, 'YYYY-MM-DD') AS penalty_date, p.note, p.source`;

export const addPenalty = async (employeeId: number, input: IDormitoryPenaltyInput): Promise<IDormitoryPenalty> => {
  const row = await queryOne<IDormitoryPenalty>(
    `INSERT INTO dormitory_penalties AS p (employee_id, penalty_date, note) VALUES ($1, $2::date, $3) ${PENALTY_RETURNING}`,
    [employeeId, input.penalty_date, input.note],
  );
  if (!row) throw new Error('dormitory penalty insert returned nothing');
  return row;
};

/** Дата и информация; сотрудник записи не меняется. Нет записи — null. */
export const updatePenalty = async (
  id: number,
  input: IDormitoryPenaltyInput,
): Promise<{ before: IDormitoryPenalty; after: IDormitoryPenalty } | null> => {
  const before = await getPenalty(id);
  if (!before) return null;
  const after = await queryOne<IDormitoryPenalty>(
    `UPDATE dormitory_penalties AS p SET penalty_date = $2::date, note = $3, updated_at = now() WHERE p.id = $1 ${PENALTY_RETURNING}`,
    [id, input.penalty_date, input.note],
  );
  return after ? { before, after } : null;
};

export const removePenalty = async (id: number): Promise<IDormitoryPenalty | null> =>
  queryOne<IDormitoryPenalty>(`DELETE FROM dormitory_penalties AS p WHERE p.id = $1 ${PENALTY_RETURNING}`, [id]);
