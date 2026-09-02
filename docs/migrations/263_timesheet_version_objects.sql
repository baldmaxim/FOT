-- Объектная разбивка часов, замороженная вместе с официальной версией табеля.
--
-- Задача: 1С забирает закрытый табель (миграция 256), но видит только часы за день.
-- У сотрудников со СКУД-учётом день складывается из проходов по нескольким объектам,
-- и понять, где человек отработал, из табеля нельзя.
--
-- Считать разбивку на лету нельзя: detail отдаёт замороженную версию, а живой расчёт
-- зависит от текущих СКУД-событий, ростера, режима табелирования и привязки точек к
-- объектам. Для одной revision метод возвращал бы разные объекты — обмен перестал бы
-- быть идемпотентным. Поэтому разбивка материализуется в той же транзакции, что и
-- версия, и живёт 1:1 с ней.
--
-- Основной payload версии, его content_hash и ответ GET /timesheets/{id} НЕ меняются.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS timesheet_version_objects (
  version_id           BIGINT PRIMARY KEY REFERENCES timesheet_versions(id) ON DELETE CASCADE,
  objects_content_hash TEXT   NOT NULL,
  payload              JSONB  NOT NULL,
  employees_count      INT    NOT NULL,
  total_hours          NUMERIC(10,2) NOT NULL,
  config_errors        JSONB  NOT NULL DEFAULT '[]'::jsonb,
  source               TEXT   NOT NULL DEFAULT 'materialize'
                              CHECK (source IN ('materialize', 'backfill')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE timesheet_version_objects IS
  'Объектная разбивка часов конкретной редакции табеля: сотрудник -> объект -> дата -> часы. '
  'Заморожена вместе с версией, не пересчитывается. Отдаётся через '
  'GET /api/public/v1/timesheets/{approval_id}/objects.';
COMMENT ON COLUMN timesheet_version_objects.version_id IS
  'PK, а не (approval_id, revision): при таком ключе противоречивая строка невозможна '
  'по построению, а редакция читается джойном к timesheet_versions.';
COMMENT ON COLUMN timesheet_version_objects.objects_content_hash IS
  'md5 канонического { payload, config_errors } — НЕ одного payload. Иначе исправление '
  'битой настройки режима, не изменившее раскладку часов, не дало бы новой редакции, и '
  'версия навсегда осталась бы с ответом 409 INVALID_EXPORT_MODE_CONFIG.';
COMMENT ON COLUMN timesheet_version_objects.payload IS
  'Канонический ответ метода целиком. Инвариант: сумма часов по объектам за день равна '
  'days[дата].hours основного payload версии — разбивка нормируется к итогу версии, '
  'а не собирается из сырых объектных интервалов.';
COMMENT ON COLUMN timesheet_version_objects.config_errors IS
  'Непустой массив = разбивку собрать корректно не удалось (режим «объект» без '
  'закреплённого объекта). Часы уходят в «Не определён», снимок пишется, но API по нему '
  'отдаёт 409 INVALID_EXPORT_MODE_CONFIG вместо молча неверных данных. Починка настройки '
  'сама редакцию не исправляет — нужна повторная материализация («Открыть → Закрыть»).';
COMMENT ON COLUMN timesheet_version_objects.source IS
  'materialize — снимок создан вместе с версией; backfill — дописан скриптом '
  'backfill-version-objects.ts к уже существующей редакции.';

COMMIT;
