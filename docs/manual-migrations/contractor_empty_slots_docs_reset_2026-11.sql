-- One-off data fix, not a migration. ASCII on purpose. NO COMMIT in this file.
-- Apply AFTER migration 359 (new columns + changed_source 'holder_reset').
--
-- Contractor pass slots that are back with the contractor without a holder (status 'assigned',
-- empty name) still carry the documents of the person who held them before. The old code of
-- "Reject selected" and of clearing the name removed the name only. When the contractor types a
-- new person into such a slot, the "Documents" window shows the passport and patent of the
-- previous person, the check mark says "complete", and the slot can be sent for approval with
-- somebody else's documents.
--
-- Target: status = 'assigned', empty effective name (open holder row or contractor_passes),
-- at least one document field filled, AND the slot had a holder that was sent for approval
-- (a contractor_pass_holders row with submission_id). Those documents belong to a person who
-- is gone. 2026-11-10 on prod: 176 slots of 37 contractors (150 not approved, 26 approved).
--
-- NOT touched: 43 slots that never had a holder (maybe a draft: the contractor filled documents
-- before the name), slots with a name, active/issued passes, the pool.
--
-- For every target slot, in one transaction, on one locked set of ids:
--   - a snapshot of the documents goes to contractor_pass_document_history
--     (changed_source 'holder_reset', changed_fields = the fields that were filled,
--     holder_name = the name of the last contractor_pass_holders row);
--   - all document fields are cleared, updated_at = now();
--   - one audit_logs row 'CONTRACTOR_SLOT_DOCS_RESET_BATCH' (entity_id = batch mark) keeps
--     pass_ids, history_ids, count and reset_at for the undo file.
--
-- Run in interactive psql (see DEPLOY.md for DATABASE_URL and PGSSLROOTCERT):
--   1. Preview, read only:
--        SELECT count(*) FROM contractor_passes p
--         WHERE p.status = 'assigned'
--           AND btrim(COALESCE((SELECT h.holder_name FROM contractor_pass_holders h
--                                WHERE h.pass_id = p.id AND h.valid_until IS NULL
--                                ORDER BY h.valid_from DESC, h.created_at DESC LIMIT 1),
--                               p.holder_name, '')) = ''
--           AND (p.passport_series_number IS NOT NULL OR p.passport_issue_date IS NOT NULL
--                OR p.birth_date IS NOT NULL OR p.citizenship IS NOT NULL
--                OR p.patent_number IS NOT NULL OR p.patent_issue_date IS NOT NULL
--                OR p.patent_blank_number IS NOT NULL OR p.has_residence_permit
--                OR p.residence_permit_number IS NOT NULL OR p.snils IS NOT NULL
--                OR p.inn IS NOT NULL OR p.kig IS NOT NULL OR p.kig_end_date IS NOT NULL)
--           AND EXISTS (SELECT 1 FROM contractor_pass_holders ph
--                        WHERE ph.pass_id = p.id AND ph.submission_id IS NOT NULL);
--   2. \set expected <that number>
--   3. \i /opt/fot-build/docs/manual-migrations/contractor_empty_slots_docs_reset_2026-11.sql
--   4. Compare the output with the \echo text at the end, then type one of:
--        COMMIT;
--        ROLLBACK;
-- Rows stay locked until then, so do not leave the session open.
-- A different number of target rows than :expected raises STOP and nothing is applied.
--
-- Undo after COMMIT:
--   docs/rollbacks/contractor_empty_slots_docs_reset_2026-11_rollback.sql

\set ON_ERROR_STOP on

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('fix.expected', :'expected', true);

DO $fix$
DECLARE
  c_batch    CONSTANT text := 'slot-docs-reset-2026-11';
  v_expected int := current_setting('fix.expected')::int;
  v_last     text;
  v_ids      uuid[];
  v_hist     uuid[];
BEGIN
  -- The batch must not be applied twice (allowed again only after its undo).
  SELECT action INTO v_last
    FROM audit_logs
   WHERE entity_id = c_batch
     AND action IN ('CONTRACTOR_SLOT_DOCS_RESET_BATCH', 'CONTRACTOR_SLOT_DOCS_RESET_UNDO')
   ORDER BY id DESC
   LIMIT 1;
  IF v_last = 'CONTRACTOR_SLOT_DOCS_RESET_BATCH' THEN
    RAISE EXCEPTION 'STOP: batch % is already applied', c_batch;
  END IF;

  -- One locked set of ids, used for the history INSERT and for the UPDATE.
  SELECT COALESCE(array_agg(t.id ORDER BY t.id), '{}')
    INTO v_ids
    FROM (
      SELECT p.id
        FROM contractor_passes p
       WHERE p.status = 'assigned'
         AND btrim(COALESCE((SELECT h.holder_name FROM contractor_pass_holders h
                              WHERE h.pass_id = p.id AND h.valid_until IS NULL
                              ORDER BY h.valid_from DESC, h.created_at DESC LIMIT 1),
                             p.holder_name, '')) = ''
         AND (p.passport_series_number IS NOT NULL OR p.passport_issue_date IS NOT NULL
              OR p.birth_date IS NOT NULL OR p.citizenship IS NOT NULL
              OR p.patent_number IS NOT NULL OR p.patent_issue_date IS NOT NULL
              OR p.patent_blank_number IS NOT NULL OR p.has_residence_permit
              OR p.residence_permit_number IS NOT NULL OR p.snils IS NOT NULL
              OR p.inn IS NOT NULL OR p.kig IS NOT NULL OR p.kig_end_date IS NOT NULL)
         AND EXISTS (SELECT 1 FROM contractor_pass_holders ph
                      WHERE ph.pass_id = p.id AND ph.submission_id IS NOT NULL)
       ORDER BY p.id
       FOR UPDATE OF p
    ) t;

  IF cardinality(v_ids) <> v_expected THEN
    RAISE EXCEPTION 'STOP: % target slots, expected %', cardinality(v_ids), v_expected;
  END IF;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'STOP: nothing to clean';
  END IF;

  WITH src AS (
    SELECT p.*,
           (SELECT ph.holder_name FROM contractor_pass_holders ph
             WHERE ph.pass_id = p.id
             ORDER BY ph.valid_from DESC, ph.created_at DESC
             LIMIT 1) AS last_holder
      FROM contractor_passes p
     WHERE p.id = ANY (v_ids)
  ), ins AS (
    INSERT INTO contractor_pass_document_history (
      pass_id, pass_number, org_department_id, holder_name,
      passport_series_number, passport_issue_date, birth_date, citizenship,
      patent_number, patent_issue_date, patent_blank_number,
      has_residence_permit, residence_permit_number,
      snils, inn, kig, kig_end_date,
      changed_fields, changed_by, changed_by_name, changed_source
    )
    SELECT s.id, s.pass_number, s.org_department_id, s.last_holder,
           s.passport_series_number, s.passport_issue_date, s.birth_date, s.citizenship,
           s.patent_number, s.patent_issue_date, s.patent_blank_number,
           s.has_residence_permit, s.residence_permit_number,
           s.snils, s.inn, s.kig, s.kig_end_date,
           array_remove(ARRAY[
             CASE WHEN NULLIF(btrim(s.passport_series_number), '') IS NOT NULL THEN 'passport_series_number' END,
             CASE WHEN s.passport_issue_date IS NOT NULL THEN 'passport_issue_date' END,
             CASE WHEN s.birth_date IS NOT NULL THEN 'birth_date' END,
             CASE WHEN NULLIF(btrim(s.citizenship), '') IS NOT NULL THEN 'citizenship' END,
             CASE WHEN NULLIF(btrim(s.patent_number), '') IS NOT NULL THEN 'patent_number' END,
             CASE WHEN s.patent_issue_date IS NOT NULL THEN 'patent_issue_date' END,
             CASE WHEN NULLIF(btrim(s.patent_blank_number), '') IS NOT NULL THEN 'patent_blank_number' END,
             CASE WHEN s.has_residence_permit THEN 'has_residence_permit' END,
             CASE WHEN NULLIF(btrim(s.residence_permit_number), '') IS NOT NULL THEN 'residence_permit_number' END,
             CASE WHEN NULLIF(btrim(s.snils), '') IS NOT NULL THEN 'snils' END,
             CASE WHEN NULLIF(btrim(s.inn), '') IS NOT NULL THEN 'inn' END,
             CASE WHEN NULLIF(btrim(s.kig), '') IS NOT NULL THEN 'kig' END,
             CASE WHEN s.kig_end_date IS NOT NULL THEN 'kig_end_date' END
           ], NULL),
           NULL, 'System: empty slot cleanup', 'holder_reset'
      FROM src s
    RETURNING id
  )
  SELECT COALESCE(array_agg(id), '{}') INTO v_hist FROM ins;

  IF cardinality(v_hist) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'STOP: % history rows for % slots', cardinality(v_hist), cardinality(v_ids);
  END IF;

  UPDATE contractor_passes
     SET passport_series_number = NULL, passport_issue_date = NULL, birth_date = NULL,
         citizenship = NULL, patent_number = NULL, patent_issue_date = NULL,
         patent_blank_number = NULL, has_residence_permit = false, residence_permit_number = NULL,
         snils = NULL, inn = NULL, kig = NULL, kig_end_date = NULL,
         updated_at = now()
   WHERE id = ANY (v_ids);

  INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, created_at)
  VALUES (NULL, 'CONTRACTOR_SLOT_DOCS_RESET_BATCH', 'contractor_pass_batch', c_batch,
          jsonb_build_object(
            'source', 'manual_sql',
            'pass_ids', to_jsonb(v_ids),
            'history_ids', to_jsonb(v_hist),
            'count', cardinality(v_ids),
            'reset_at', now()),
          now());

  RAISE NOTICE 'Cleaned % slots, % history rows', cardinality(v_ids), cardinality(v_hist);
END
$fix$;

-- Check: slots of this batch with any document left (must be 0) and the batch size.
WITH b AS (
  SELECT details FROM audit_logs
   WHERE action = 'CONTRACTOR_SLOT_DOCS_RESET_BATCH' AND entity_id = 'slot-docs-reset-2026-11'
   ORDER BY id DESC LIMIT 1
), ids AS (
  SELECT jsonb_array_elements_text(b.details->'pass_ids')::uuid AS id FROM b
)
SELECT (SELECT (details->>'count')::int FROM b) AS batch_count,
       count(p.id) AS slots_found,
       count(*) FILTER (WHERE p.passport_series_number IS NOT NULL OR p.passport_issue_date IS NOT NULL
                          OR p.birth_date IS NOT NULL OR p.citizenship IS NOT NULL
                          OR p.patent_number IS NOT NULL OR p.patent_issue_date IS NOT NULL
                          OR p.patent_blank_number IS NOT NULL OR p.has_residence_permit
                          OR p.residence_permit_number IS NOT NULL OR p.snils IS NOT NULL
                          OR p.inn IS NOT NULL OR p.kig IS NOT NULL OR p.kig_end_date IS NOT NULL)
         AS still_with_docs
  FROM ids JOIN contractor_passes p ON p.id = ids.id;

\echo
\echo Expected: NOTICE "Cleaned N slots, N history rows" with N = :expected,
\echo then batch_count = slots_found = N and still_with_docs = 0.
\echo If it matches type COMMIT; otherwise type ROLLBACK;
