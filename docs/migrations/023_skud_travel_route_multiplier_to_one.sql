BEGIN;

UPDATE skud_object_routes
SET credit_multiplier = 1
WHERE credit_multiplier IS DISTINCT FROM 1;

ALTER TABLE skud_object_routes
ALTER COLUMN credit_multiplier SET DEFAULT 1;

COMMIT;
