-- Миграция 152: архив треков МТС в БД для исторического просмотра.
--
-- Карта сотрудника (MtsMapModal) раньше строила трек из ЖИВЫХ GET к МТС, поэтому
-- «спустя время» данные пропадали (МТС хранит историю ограниченно). Теперь поллер
-- mts-location-poller на каждом тике складывает в эти таблицы:
--   • GPS-точки приложения «МТС-Координатор» (getGlobalLocations) — плотный маршрут;
--   • сегменты Старт→Финиш (getTracksRange) — по LBS, есть даже без приложения.
-- Без установленного «Координатора» реально копятся в основном сегменты; таблица
-- GPS готова на будущее.
--
-- Координаты и адреса — PII сотрудника, шифруем (AES-256-GCM, формат
-- iv:authTag:ciphertext), как в mts_location_snapshots. distance/duration —
-- агрегаты, не PII, храним как есть. Дедуп по бизнес-ключу МТС (location_id /
-- track_id). Хранение бессрочное (автоочистки нет — по требованию).
--
-- Применяется вручную через psql (авто-миграций в проекте нет).

BEGIN;

-- 1. GPS-точки «Координатора». Дедуп по (subscriber_id, location_id).
CREATE TABLE IF NOT EXISTS mts_gps_points (
  subscriber_id  BIGINT      NOT NULL,
  location_id    BIGINT      NOT NULL,
  recorded_at    TIMESTAMPTZ NOT NULL,
  lat_enc        TEXT,
  lon_enc        TEXT,
  velocity_enc   TEXT,
  angle_enc      TEXT,
  is_valid       BOOLEAN,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscriber_id, location_id)
);

CREATE INDEX IF NOT EXISTS idx_mts_gps_points_sub_time
  ON mts_gps_points (subscriber_id, recorded_at DESC);

-- 2. Сегменты Старт→Финиш (LBS). Дедуп по (subscriber_id, track_id).
CREATE TABLE IF NOT EXISTS mts_track_segments (
  subscriber_id      BIGINT NOT NULL,
  track_id           BIGINT NOT NULL,
  start_at           TIMESTAMPTZ,
  finish_at          TIMESTAMPTZ,
  start_lat_enc      TEXT,
  start_lon_enc      TEXT,
  finish_lat_enc     TEXT,
  finish_lon_enc     TEXT,
  start_address_enc  TEXT,
  finish_address_enc TEXT,
  distance_m         DOUBLE PRECISION,
  duration_s         DOUBLE PRECISION,
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscriber_id, track_id)
);

CREATE INDEX IF NOT EXISTS idx_mts_track_segments_sub_time
  ON mts_track_segments (subscriber_id, start_at DESC);

COMMIT;
