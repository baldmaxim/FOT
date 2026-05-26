-- Миграция 126: связь геозон МТС с объектами FOT (skud_objects).
-- Объект FOT = объединение точек доступа (skud_objects, миграция 026).
-- Через эту связь зону можно «прикрепить» к стройке/объекту, а не только
-- индивидуально к сотрудникам. Бизнес-логика «попадания в зону» не меняется —
-- эта таблица только хранит ассоциацию для UI/отчётов.
--
-- Применяется вручную через psql (авто-миграций в проекте нет).

BEGIN;

CREATE TABLE IF NOT EXISTS mts_geofence_objects (
  geofence_id     UUID        NOT NULL REFERENCES mts_geofences(id) ON DELETE CASCADE,
  skud_object_id  UUID        NOT NULL REFERENCES skud_objects(id)  ON DELETE CASCADE,
  assigned_by     UUID,
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (geofence_id, skud_object_id)
);

CREATE INDEX IF NOT EXISTS idx_mts_geofence_objects_object
  ON mts_geofence_objects(skud_object_id);

COMMIT;
