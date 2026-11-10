-- Undo of docs/manual-migrations/contractor_empty_slots_docs_reset_2026-11.sql.
-- ASCII on purpose. NO COMMIT in this file.
--
-- Takes pass_ids and history_ids from the latest 'CONTRACTOR_SLOT_DOCS_RESET_BATCH' audit row
-- (entity_id 'slot-docs-reset-2026-11'), puts the documents back into exactly these slots from
-- exactly these history rows, deletes those history rows (they described the cleanup) and writes
-- an audit row 'CONTRACTOR_SLOT_DOCS_RESET_UNDO'.
--
-- Refuses with STOP when the state is not exactly what the cleanup left behind:
--   - there is no applied batch (or it was already undone);
--   - a history row of the batch is missing;
--   - any slot of the batch got a holder, a document, another status or any change after the
--     cleanup (updated_at differs from reset_at), or a newer history row. Somebody already
--     works with that slot: going back would overwrite their data, the only way is forward.
--
-- Run in interactive psql:
--   \i /opt/fot-build/docs/rollbacks/contractor_empty_slots_docs_reset_2026-11_rollback.sql
-- Check the output, then type COMMIT; or ROLLBACK;

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $undo$
DECLARE
  c_batch  CONSTANT text := 'slot-docs-reset-2026-11';
  v_action text;
  v_details jsonb;
  v_ids    uuid[];
  v_hist   uuid[];
  v_at     timestamptz;
  v_bad    int;
BEGIN
  SELECT action, details INTO v_action, v_details
    FROM audit_logs
   WHERE entity_id = c_batch
     AND action IN ('CONTRACTOR_SLOT_DOCS_RESET_BATCH', 'CONTRACTOR_SLOT_DOCS_RESET_UNDO')
   ORDER BY id DESC
   LIMIT 1;
  IF v_action IS DISTINCT FROM 'CONTRACTOR_SLOT_DOCS_RESET_BATCH' THEN
    RAISE EXCEPTION 'STOP: no applied batch % to undo', c_batch;
  END IF;

  v_ids  := ARRAY(SELECT jsonb_array_elements_text(v_details->'pass_ids')::uuid ORDER BY 1);
  v_hist := ARRAY(SELECT jsonb_array_elements_text(v_details->'history_ids')::uuid);
  v_at   := (v_details->>'reset_at')::timestamptz;

  PERFORM 1 FROM contractor_passes WHERE id = ANY (v_ids) ORDER BY id FOR UPDATE;

  IF (SELECT count(*) FROM contractor_pass_document_history
       WHERE id = ANY (v_hist) AND pass_id = ANY (v_ids) AND changed_source = 'holder_reset')
     <> cardinality(v_hist)
     OR cardinality(v_hist) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'STOP: history rows of the batch are missing';
  END IF;

  SELECT count(*) INTO v_bad
    FROM contractor_passes p
   WHERE p.id = ANY (v_ids)
     AND (p.updated_at IS DISTINCT FROM v_at
          OR p.status <> 'assigned'
          OR btrim(COALESCE((SELECT h.holder_name FROM contractor_pass_holders h
                              WHERE h.pass_id = p.id AND h.valid_until IS NULL
                              ORDER BY h.valid_from DESC, h.created_at DESC LIMIT 1),
                             p.holder_name, '')) <> ''
          OR p.passport_series_number IS NOT NULL OR p.passport_issue_date IS NOT NULL
          OR p.birth_date IS NOT NULL OR p.citizenship IS NOT NULL
          OR p.patent_number IS NOT NULL OR p.patent_issue_date IS NOT NULL
          OR p.patent_blank_number IS NOT NULL OR p.has_residence_permit
          OR p.residence_permit_number IS NOT NULL OR p.snils IS NOT NULL
          OR p.inn IS NOT NULL OR p.kig IS NOT NULL OR p.kig_end_date IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'STOP: % slots changed after the cleanup', v_bad;
  END IF;

  IF EXISTS (SELECT 1 FROM contractor_pass_document_history
              WHERE pass_id = ANY (v_ids) AND NOT (id = ANY (v_hist)) AND changed_at > v_at) THEN
    RAISE EXCEPTION 'STOP: newer document history after the cleanup';
  END IF;

  UPDATE contractor_passes p
     SET passport_series_number = h.passport_series_number,
         passport_issue_date = h.passport_issue_date,
         birth_date = h.birth_date,
         citizenship = h.citizenship,
         patent_number = h.patent_number,
         patent_issue_date = h.patent_issue_date,
         patent_blank_number = h.patent_blank_number,
         has_residence_permit = COALESCE(h.has_residence_permit, false),
         residence_permit_number = h.residence_permit_number,
         snils = h.snils,
         inn = h.inn,
         kig = h.kig,
         kig_end_date = h.kig_end_date,
         updated_at = now()
    FROM contractor_pass_document_history h
   WHERE h.id = ANY (v_hist) AND h.pass_id = p.id;

  DELETE FROM contractor_pass_document_history WHERE id = ANY (v_hist);

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at)
  VALUES (NULL, 'CONTRACTOR_SLOT_DOCS_RESET_UNDO', 'contractor_pass_batch', c_batch,
          jsonb_build_object('source', 'manual_sql', 'pass_ids', to_jsonb(v_ids),
                             'count', cardinality(v_ids)),
          now());

  RAISE NOTICE 'Restored % slots', cardinality(v_ids);
END
$undo$;

\echo
\echo Expected: NOTICE "Restored N slots" with N = the batch size.
\echo If it matches type COMMIT; otherwise type ROLLBACK;
