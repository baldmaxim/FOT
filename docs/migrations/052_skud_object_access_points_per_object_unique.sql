-- Migration 052: снимаем единый UNIQUE(access_point_name) с маппингов точек к объектам.
-- Одна точка может физически принадлежать нескольким объектам (например, при перепривязке).
-- Сохраняем составной UNIQUE(object_id, access_point_name), чтобы один объект не имел дубликатов.

BEGIN;

ALTER TABLE skud_object_access_points
  DROP CONSTRAINT IF EXISTS skud_object_access_points_access_point_name_key;

ALTER TABLE skud_object_map_points
  DROP CONSTRAINT IF EXISTS skud_object_map_points_access_point_name_key;

COMMIT;
