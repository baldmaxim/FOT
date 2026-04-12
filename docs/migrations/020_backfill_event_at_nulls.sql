-- One-time repair after migration 020:
-- fill skud_events.event_at for rows that were inserted after migration
-- by legacy ingestion paths that did not yet write event_at.

UPDATE skud_events
SET event_at = ((event_date::text || ' ' || event_time::text)::timestamp AT TIME ZONE 'Europe/Moscow')
WHERE event_at IS NULL
  AND event_date IS NOT NULL
  AND event_time IS NOT NULL;

SELECT count(*) AS missing_event_at
FROM skud_events
WHERE event_at IS NULL;
