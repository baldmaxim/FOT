/**
 * «Не ходят больше N дней» в статистике пропусков подрядчиков: новые номерные пропуска,
 * по которым у текущего держателя нет проходов СКУД дольше IDLE_PASS_DAYS дней.
 *
 * Счётчик сводки, список и очередь автоблокировки строятся одним фрагментом WHERE — числа
 * не расходятся. Пример для today = 26.10, IDLE_PASS_DAYS = 5 (порог 21.10):
 *   • пропуск активен или заблокирован за простой/вручную (отметка на строке держателя),
 *     текущий держатель одобрен (approved_at = фактическая выдача);
 *   • выдан до порога: МСК-дата approved_at < 21.10;
 *   • нет проходов (entry/exit) в МСК-интервале [21.10 00:00; 27.10 00:00). Верхняя граница —
 *     событие «из будущего» не прячет пропуск и не даёт отрицательных дней;
 *   • нет разблокировки в журнале за тот же интервал: разблокированному даём те же 5 дней.
 *     Журнал, а не колонка: разблокировки до включения автоблокировки тоже считаются;
 *   • дни = today − МСК-дата самого позднего из: последний проход после выдачи, выдача, разблокировка.
 * Проходы ищутся по всем строкам employees с Sigur-id пропуска (skud_events.employee_id —
 * локальный employees.id), без фильтров по статусу и архиву — как проходы по пропуску в «Мониторинге».
 */
import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';

/** Больше стольких дней без проходов — пропуск в «Не ходят». */
export const IDLE_PASS_DAYS = 5;

/**
 * Фрагмент FROM/WHERE: p — пропуск, h — текущий одобренный держатель. Параметры: $1 — org_department_id[],
 * $2 — сегодня (МСК), $3 — IDLE_PASS_DAYS. Event_date рядом с event_at — для отсечения партиций.
 */
const IDLE_PASSES_FROM_SQL = `
  FROM contractor_passes p
  JOIN contractor_pass_holders h
    ON h.pass_id = p.id AND h.valid_until IS NULL AND h.approved_at IS NOT NULL
 WHERE p.org_department_id = ANY($1::uuid[])
   AND (p.is_active OR (p.status = 'applied'
        AND (h.idle_blocked_at IS NOT NULL OR h.external_blocked_seen_at IS NOT NULL)))
   AND (h.approved_at AT TIME ZONE 'Europe/Moscow')::date < $2::date - $3::int
   AND NOT EXISTS (
     SELECT 1
       FROM employees e
       JOIN skud_events se ON se.employee_id = e.id
      WHERE e.sigur_employee_id = p.sigur_employee_id
        AND se.event_at >= ($2::date - $3::int)::timestamp AT TIME ZONE 'Europe/Moscow'
        AND se.event_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
        AND se.event_date BETWEEN $2::date - $3::int AND $2::date
        AND se.direction IN ('entry', 'exit')
   )
   AND NOT EXISTS (
     SELECT 1
       FROM audit_logs a
      WHERE a.entity_type = 'sigur_employee'
        AND a.entity_id = p.sigur_employee_id::text
        AND a.created_at >= ($2::date - $3::int)::timestamp AT TIME ZONE 'Europe/Moscow'
        AND a.created_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
        AND a.details->>'action' = 'unblock'
   )`;

/** Дополнение к фрагменту: кого автоблокировка ещё не обрабатывала. */
const IDLE_BLOCK_CANDIDATE_SQL = `
   AND p.status = 'applied'
   AND p.is_active
   AND p.sigur_employee_id IS NOT NULL
   AND h.idle_blocked_at IS NULL
   AND h.external_blocked_seen_at IS NULL`;

export interface IIdlePassCountRow {
  org_department_id: string;
  idle_new: number;
}

/** Число не ходящих по подрядчикам; подрядчиков без таких пропусков в ответе нет. */
export const countIdlePassesByOrg = async (
  orgIds: string[],
  today: string,
): Promise<IIdlePassCountRow[]> => {
  if (orgIds.length === 0) return [];
  return query<IIdlePassCountRow>(
    `SELECT p.org_department_id::text AS org_department_id, count(*)::int AS idle_new
     ${IDLE_PASSES_FROM_SQL}
      GROUP BY p.org_department_id`,
    [orgIds, today, IDLE_PASS_DAYS],
  );
};

export interface IIdlePassRow {
  pass_id: string;
  holder_id: string;
  org_department_id: string;
  org_name: string;
  pass_number: string;
  sigur_employee_id: number | null;
  holder_name: string;
  /** МСК-дата выдачи текущему держателю, YYYY-MM-DD. */
  issued_on: string;
  /** МСК-дата последнего прохода после выдачи, YYYY-MM-DD; null — проходов не было. */
  last_event_date: string | null;
  last_access_point: string | null;
  days_idle: number;
  /** МСК-дата автоблокировки, YYYY-MM-DD; null — автоблокировки не было. */
  idle_blocked_on: string | null;
  /** Профиль заблокирован вручную с причиной, автоблокировка его только увидела. */
  blocked_manually: boolean;
}

/**
 * Не ходящие с последним проходом. Последний проход — только после approved_at текущего держателя
 * (пропуск — переиспользуемый слот) и до конца сегодняшнего дня; при равном event_at — больший id,
 * чтобы точка не менялась от запроса к запросу.
 */
const fetchIdleRows = (
  orgIds: string[],
  today: string,
  extraWhereSql: string,
  orderBySql: string,
): Promise<IIdlePassRow[]> =>
  query<IIdlePassRow>(
    `WITH idle AS (
       SELECT p.id, h.id AS holder_id, p.org_department_id, p.pass_number, p.sigur_employee_id,
              COALESCE(h.holder_name, p.holder_name, '—') AS holder_name,
              h.approved_at, h.idle_blocked_at, h.external_blocked_seen_at, h.idle_block_failed_at,
              (h.approved_at AT TIME ZONE 'Europe/Moscow')::date AS issued_on
       ${IDLE_PASSES_FROM_SQL}
       ${extraWhereSql}
     ),
     last_event AS (
       SELECT DISTINCT ON (i.id) i.id AS pass_id, le.event_date, le.access_point
         FROM idle i
         JOIN employees e ON e.sigur_employee_id = i.sigur_employee_id
         CROSS JOIN LATERAL (
           SELECT se.id, se.event_at, (se.event_at AT TIME ZONE 'Europe/Moscow')::date AS event_date,
                  se.access_point
             FROM skud_events se
            WHERE se.employee_id = e.id
              AND se.event_at >= i.approved_at
              AND se.event_at <  ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
              AND se.event_date BETWEEN i.issued_on - 1 AND $2::date
              AND se.direction IN ('entry', 'exit')
            ORDER BY se.event_at DESC, se.id DESC
            LIMIT 1
         ) le
        ORDER BY i.id, le.event_at DESC, le.id DESC
     ),
     last_unblock AS (
       SELECT i.id AS pass_id, (u.created_at AT TIME ZONE 'Europe/Moscow')::date AS unblocked_on
         FROM idle i
         CROSS JOIN LATERAL (
           SELECT a.created_at
             FROM audit_logs a
            WHERE a.entity_type = 'sigur_employee'
              AND a.entity_id = i.sigur_employee_id::text
              AND a.created_at < ($2::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow'
              AND a.details->>'action' = 'unblock'
            ORDER BY a.created_at DESC
            LIMIT 1
         ) u
     )
     SELECT i.id AS pass_id,
            i.holder_id::text AS holder_id,
            i.org_department_id::text AS org_department_id,
            COALESCE(od.name, '—') AS org_name,
            i.pass_number,
            i.sigur_employee_id::int AS sigur_employee_id,
            i.holder_name,
            to_char(i.issued_on, 'YYYY-MM-DD') AS issued_on,
            to_char(l.event_date, 'YYYY-MM-DD') AS last_event_date,
            NULLIF(btrim(l.access_point), '') AS last_access_point,
            ($2::date - GREATEST(l.event_date, i.issued_on, u.unblocked_on))::int AS days_idle,
            to_char(i.idle_blocked_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS idle_blocked_on,
            (i.external_blocked_seen_at IS NOT NULL) AS blocked_manually
       FROM idle i
       LEFT JOIN last_event l ON l.pass_id = i.id
       LEFT JOIN last_unblock u ON u.pass_id = i.id
       LEFT JOIN org_departments od ON od.id = i.org_department_id
      ORDER BY ${orderBySql}`,
    [orgIds, today, IDLE_PASS_DAYS],
  );

/** Список «Не ходят»: подрядчик, дни ↓, номер. */
export const fetchIdleContractorPasses = async (
  orgIds: string[],
  today: string,
): Promise<IIdlePassRow[]> => {
  if (orgIds.length === 0) return [];
  return fetchIdleRows(orgIds, today, '', 'od.name, days_idle DESC, i.pass_number::int');
};

/**
 * Очередь автоблокировки по всем подрядчикам. Сначала те, у кого не было ошибок: иначе одни и те же
 * проблемные пропуска занимали бы начало каждого запуска. Дальше — кто не ходит дольше всех.
 */
export const fetchIdleBlockCandidates = async (today: string): Promise<IIdlePassRow[]> => {
  const orgs = await query<{ id: string }>(
    `SELECT DISTINCT org_department_id::text AS id
       FROM contractor_passes
      WHERE is_active AND org_department_id IS NOT NULL`,
  );
  if (orgs.length === 0) return [];
  return fetchIdleRows(
    orgs.map(org => org.id),
    today,
    IDLE_BLOCK_CANDIDATE_SQL,
    'i.idle_block_failed_at NULLS FIRST, days_idle DESC, i.pass_number::int',
  );
};

/**
 * Перепроверка кандидата под блокировкой строк: тот же держатель, ещё активен, без отметок,
 * нет проходов и разблокировки. false — за время прогона что-то изменилось, пропуск не трогаем.
 */
export const lockIdleBlockCandidate = async (
  client: PoolClient,
  candidate: { orgDepartmentId: string; passId: string; holderId: string },
  today: string,
): Promise<boolean> => {
  const result = await client.query(
    `SELECT p.id
     ${IDLE_PASSES_FROM_SQL}
     ${IDLE_BLOCK_CANDIDATE_SQL}
        AND p.id = $4::uuid
        AND h.id::text = $5
      FOR UPDATE OF p, h`,
    [[candidate.orgDepartmentId], today, IDLE_PASS_DAYS, candidate.passId, candidate.holderId],
  );
  return result.rows.length === 1;
};

/**
 * Разблокировка профиля: снимает отметки держателя и возвращает пропуску активность. Только в
 * транзакции вызывающего — вместе с записью журнала, по которой считается новый отсчёт 5 дней.
 */
export const markContractorPassUnblocked = async (
  client: PoolClient,
  sigurEmployeeId: number,
): Promise<void> => {
  const holders = await client.query<{ pass_id: string }>(
    `UPDATE contractor_pass_holders h
        SET idle_blocked_at = NULL,
            external_blocked_seen_at = NULL,
            idle_block_failed_at = NULL
       FROM contractor_passes p
      WHERE h.pass_id = p.id
        AND h.valid_until IS NULL
        AND p.sigur_employee_id = $1
        AND p.status = 'applied'
        AND (h.idle_blocked_at IS NOT NULL OR h.external_blocked_seen_at IS NOT NULL)
      RETURNING h.pass_id`,
    [sigurEmployeeId],
  );
  if (holders.rows.length === 0) return;
  await client.query(
    `UPDATE contractor_passes
        SET is_active = true, updated_at = now()
      WHERE id = ANY($1::uuid[]) AND status = 'applied'`,
    [holders.rows.map(row => row.pass_id)],
  );
};
