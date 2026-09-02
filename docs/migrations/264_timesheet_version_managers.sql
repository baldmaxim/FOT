-- Руководители отдела, замороженные вместе с официальной версией табеля.
--
-- Задача: 1С должна видеть, кто руководитель отдела сотрудника. В теле табеля есть
-- только manager_employee_id — это ПОДАВШИЙ табель руководитель из timesheet_approvals,
-- а не начальник конкретного человека.
--
-- Считать на лету нельзя: /timesheets/{id} отдаёт замороженную редакцию, а живой
-- резолвинг после любой правки оргструктуры вернул бы для той же revision другой ответ —
-- 1С не смогла бы воспроизвести документ. Поэтому снимок материализуется в одной
-- транзакции с версией и живёт 1:1 с ней.
--
-- Отдельная таблица, а не колонка в timesheet_version_objects (миграция 263): та уже
-- забэкфиллена, новое поле сменило бы objects_content_hash всем редакциям.
--
-- Основной payload версии, его content_hash и ответ GET /timesheets/{id} НЕ меняются.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS timesheet_version_managers (
  version_id            BIGINT PRIMARY KEY REFERENCES timesheet_versions(id) ON DELETE CASCADE,
  managers_content_hash TEXT   NOT NULL,
  payload               JSONB  NOT NULL,
  employees_count       INT    NOT NULL,
  without_manager       INT    NOT NULL,
  snapshot_source       TEXT   NOT NULL DEFAULT 'materialize'
                               CHECK (snapshot_source IN ('materialize', 'backfill_current_state')),
  resolved_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE timesheet_version_managers IS
  'Руководители отдела по каждому сотруднику конкретной редакции табеля. Заморожены '
  'вместе с версией, не пересчитываются. Отдаются через '
  'GET /api/public/v1/timesheets/{approval_id}/managers.';
COMMENT ON COLUMN timesheet_version_managers.version_id IS
  'PK, а не (approval_id, revision): при таком ключе противоречивая строка невозможна '
  'по построению, а редакция читается джойном к timesheet_versions.';
COMMENT ON COLUMN timesheet_version_managers.managers_content_hash IS
  'md5 канонического payload. Участвует в решении о новой редакции наравне с '
  'content_hash и objects_content_hash: смена руководителя при неизменных часах обязана '
  'быть замечена 1С.';
COMMENT ON COLUMN timesheet_version_managers.payload IS
  'Отдел сотрудника в рамках этого табеля + руководители ЭТОГО отдела. Руководителем '
  'считается активный ручной full-доступ (employee_department_access, access_level=full, '
  'source <> sigur_sync): отдельного поля «руководитель отдела» в схеме нет. Прямые '
  'руководители (employee_direct_reports) и наследование от родительских отделов НЕ '
  'используются — это дало бы человеку начальника из чужого отдела.';
COMMENT ON COLUMN timesheet_version_managers.without_manager IS
  'Сотрудников без руководителя. Штатная величина, а не дефект: на момент внедрения у '
  'отделов ЛИНИЯ и ЛИНИЯ-Общестрой руководитель не назначен вовсе.';
COMMENT ON COLUMN timesheet_version_managers.snapshot_source IS
  'materialize — состояние на момент СОЗДАНИЯ РЕДАКЦИИ (не «руководитель на даты '
  'табеля»: истории назначений в employee_department_access нет вообще, только is_active). '
  'backfill_current_state — состояние на момент прогона бэкфилла, то есть заведомо позже '
  'закрытия редакции. 1С обязана различать эти случаи.';
COMMENT ON COLUMN timesheet_version_managers.resolved_at IS
  'Когда фактически выполнен резолвинг. Для backfill_current_state — единственный '
  'ориентир, к какому моменту относятся данные.';

COMMIT;
