-- Миграция 112: геозоны МТС «Мобильные сотрудники».
-- Дополняет модуль (миграция 108) тремя таблицами для произвольных полигональных
-- зон, их назначений сотрудникам и журнала нарушений в рабочее время.
--
-- Геометрия зон — plain JSONB (массив {lat,lng}, ≥3 точек). Зоны описывают
-- объекты/площадки (бизнес-данные, не PII), потому не шифруем — это нужно
-- для дебага и потенциальных spatial-запросов. Координаты нарушений —
-- это PII сотрудника, шифруем (AES-256-GCM, формат iv:authTag:ciphertext).
--
-- Активность зон контролируется поллером mts-geofence-monitor.service.ts:
-- зона срабатывает ТОЛЬКО когда у сотрудника по schedule.service идёт смена
-- (см. getActiveShiftWindow в mts-geofence-geometry.ts).
--
-- Применяется вручную через psql (авто-миграций в проекте нет).

BEGIN;

-- 1. Геозоны (полигоны). Геометрия = JSONB-массив объектов {lat:number, lng:number}.
CREATE TABLE IF NOT EXISTS mts_geofences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  geometry    JSONB NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_by  UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(geometry) = 'array' AND jsonb_array_length(geometry) >= 3)
);

CREATE INDEX IF NOT EXISTS idx_mts_geofences_active
  ON mts_geofences(is_active) WHERE is_active;

-- 2. Назначения зон сотрудникам. Композитный PK предотвращает дубли.
--    Без срока действия — окно контроля задаётся графиком работ сотрудника.
CREATE TABLE IF NOT EXISTS mts_geofence_assignments (
  geofence_id  UUID NOT NULL REFERENCES mts_geofences(id) ON DELETE CASCADE,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  assigned_by  UUID,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (geofence_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_mts_geofence_assignments_employee
  ON mts_geofence_assignments(employee_id) WHERE is_active;

-- 3. Журнал нарушений. Одна строка = один непрерывный out-of-zone эпизод.
--    Координаты сотрудника на момент детекции — шифруем (PII).
CREATE TABLE IF NOT EXISTS mts_geofence_violations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  geofence_id       UUID NOT NULL REFERENCES mts_geofences(id) ON DELETE CASCADE,
  employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  last_notified_at  TIMESTAMPTZ,
  notify_count      INTEGER NOT NULL DEFAULT 0,
  latitude_enc      TEXT,
  longitude_enc     TEXT,
  accuracy_m_enc    TEXT,
  source_enc        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Открытые нарушения по паре (геозона, сотрудник) — partial-индекс для
-- быстрого UPSERT-сценария поллера (ищем «есть ли уже открытая запись»).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mts_geofence_violations_open
  ON mts_geofence_violations(geofence_id, employee_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mts_geofence_violations_employee_recent
  ON mts_geofence_violations(employee_id, started_at DESC);

COMMIT;
