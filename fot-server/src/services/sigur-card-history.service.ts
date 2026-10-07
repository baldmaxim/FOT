/**
 * История изменений карты сотрудника Sigur — собирается из audit_logs.
 *
 * Три источника:
 *  - поштучные правки из сайдбара SIGUR (entity_type 'sigur_employee');
 *  - привязка/отвязка карты и правки из карточки сотрудника ('sigur_card_binding');
 *  - итоговые записи массового продления и его отката ('sigur_card_bulk_extend').
 *
 * Ограничения: у поштучных правок прежний срок в журнал не писался; массовая
 * операция без итоговой записи журнала сюда не попадёт; правки напрямую в Sigur
 * Manager не видны вовсе.
 */
import { query } from '../config/postgres.js';

export type SigurCardHistoryKind =
  | 'update_card_expiration'
  | 'update_card_binding'
  | 'assign_card_binding'
  | 'remove_card_binding'
  | 'bulk_extend'
  | 'bulk_rollback';

export interface ISigurCardHistoryEntry {
  id: string;
  createdAt: string;
  kind: SigurCardHistoryKind;
  startDate: string | null;
  expirationDate: string | null;
  previousExpiration: string | null;
  actorName: string | null;
}

interface ISigurCardHistoryRow {
  id: string | number;
  created_at: Date | string;
  kind: SigurCardHistoryKind;
  start_date: string | null;
  expiration_date: string | null;
  previous_expiration: string | null;
  actor_name: string | null;
}

const HISTORY_LIMIT = 100;

// ID сравниваются как текст: битая старая запись журнала не должна ронять
// весь запрос на приведении типа.
const SIGUR_CARD_HISTORY_SQL = `
  WITH events AS (
    SELECT a.id, a.created_at, a.user_id,
           a.details->>'action' AS kind,
           a.details->>'startDate' AS start_date,
           a.details->>'expirationDate' AS expiration_date,
           NULL::text AS previous_expiration
      FROM audit_logs a
     WHERE a.entity_type = 'sigur_employee'
       AND a.entity_id = $1::text
       AND a.details->>'action' IN ('update_card_expiration', 'update_card_binding')
       AND a.details->>'cardId' = $2::text
    UNION ALL
    SELECT a.id, a.created_at, a.user_id,
           COALESCE(
             a.details->>'action',
             CASE
               WHEN a.details ? 'uid' THEN 'assign_card_binding'
               WHEN a.details ? 'startDate' THEN 'update_card_binding'
               ELSE 'update_card_expiration'
             END
           ),
           a.details->>'startDate',
           a.details->>'expirationDate',
           NULL::text
      FROM audit_logs a
     WHERE a.entity_type = 'sigur_card_binding'
       AND a.details->>'sigurEmployeeId' = $1::text
       AND a.details->>'cardId' = $2::text
    UNION ALL
    SELECT a.id, a.created_at, a.user_id,
           CASE WHEN a.details->>'action' LIKE 'bulk_extend_cards_rollback%' THEN 'bulk_rollback' ELSE 'bulk_extend' END,
           NULL::text,
           CASE WHEN item->>'status' = 'rollback_extended' THEN item->>'previousExpiration' ELSE a.details->>'expirationDate' END,
           CASE WHEN item->>'status' = 'rollback_extended' THEN NULL ELSE item->>'previousExpiration' END
      FROM audit_logs a
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(a.details->'items') = 'array' THEN a.details->'items' ELSE '[]'::jsonb END
      ) item
     WHERE a.entity_type = 'sigur_card_bulk_extend'
       AND a.details->>'action' IN (
         'bulk_extend_cards_completed',
         'bulk_extend_cards_partial',
         'bulk_extend_cards_rollback_completed',
         'bulk_extend_cards_rollback_partial'
       )
       AND item->>'employeeId' = $1::text
       AND item->>'cardId' = $2::text
       AND item->>'status' IN ('extended', 'extended_after_retry', 'rollback_extended')
  )
  SELECT e.id, e.created_at, e.kind, e.start_date, e.expiration_date, e.previous_expiration,
         up.full_name AS actor_name
    FROM events e
    LEFT JOIN user_profiles up ON up.id = e.user_id
   ORDER BY e.created_at DESC, e.id DESC
   LIMIT ${HISTORY_LIMIT}
`;

export async function getSigurCardHistory(
  sigurEmployeeId: number,
  cardId: number,
): Promise<ISigurCardHistoryEntry[]> {
  const rows = await query<ISigurCardHistoryRow>(
    SIGUR_CARD_HISTORY_SQL,
    [String(sigurEmployeeId), String(cardId)],
  );
  return rows.map(row => ({
    id: String(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    kind: row.kind,
    startDate: row.start_date,
    expirationDate: row.expiration_date,
    previousExpiration: row.previous_expiration,
    actorName: row.actor_name,
  }));
}
