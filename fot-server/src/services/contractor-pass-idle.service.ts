/**
 * «Не ходят больше N дней» в статистике пропусков подрядчиков: активные новые номерные пропуска,
 * по которым у текущего держателя нет проходов СКУД дольше IDLE_PASS_DAYS дней.
 *
 * Счётчик сводки и список строятся одним фрагментом WHERE — числа не расходятся. Пример для
 * today = 26.10, IDLE_PASS_DAYS = 5 (порог 21.10):
 *   • пропуск активен, текущий держатель одобрен (approved_at = фактическая выдача);
 *   • выдан до порога: МСК-дата approved_at < 21.10;
 *   • нет проходов (entry/exit) в МСК-интервале [21.10 00:00; 27.10 00:00). Верхняя граница —
 *     событие «из будущего» не прячет пропуск и не даёт отрицательных дней;
 *   • дни = today − МСК-дата последнего прохода после выдачи, без проходов — от даты выдачи.
 * Проходы ищутся по всем строкам employees с Sigur-id пропуска (skud_events.employee_id —
 * локальный employees.id), без фильтров по статусу и архиву — как проходы по пропуску в «Мониторинге».
 */
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
   AND p.is_active
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
   )`;

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
  org_department_id: string;
  org_name: string;
  pass_number: string;
  holder_name: string;
  /** МСК-дата последнего прохода после выдачи, YYYY-MM-DD; null — проходов не было. */
  last_event_date: string | null;
  last_access_point: string | null;
  days_idle: number;
}

/**
 * Не ходящие с последним проходом. Последний проход — только после approved_at текущего держателя
 * (пропуск — переиспользуемый слот) и до конца сегодняшнего дня; при равном event_at — больший id,
 * чтобы точка не менялась от запроса к запросу. Порядок: подрядчик, дни ↓, номер.
 */
export const fetchIdleContractorPasses = async (
  orgIds: string[],
  today: string,
): Promise<IIdlePassRow[]> => {
  if (orgIds.length === 0) return [];
  return query<IIdlePassRow>(
    `WITH idle AS (
       SELECT p.id, p.org_department_id, p.pass_number, p.sigur_employee_id,
              COALESCE(h.holder_name, p.holder_name, '—') AS holder_name,
              h.approved_at,
              (h.approved_at AT TIME ZONE 'Europe/Moscow')::date AS issued_on
       ${IDLE_PASSES_FROM_SQL}
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
     )
     SELECT i.id AS pass_id,
            i.org_department_id::text AS org_department_id,
            COALESCE(od.name, '—') AS org_name,
            i.pass_number,
            i.holder_name,
            to_char(l.event_date, 'YYYY-MM-DD') AS last_event_date,
            NULLIF(btrim(l.access_point), '') AS last_access_point,
            ($2::date - COALESCE(l.event_date, i.issued_on))::int AS days_idle
       FROM idle i
       LEFT JOIN last_event l ON l.pass_id = i.id
       LEFT JOIN org_departments od ON od.id = i.org_department_id
      ORDER BY od.name, days_idle DESC, i.pass_number::int`,
    [orgIds, today, IDLE_PASS_DAYS],
  );
};
