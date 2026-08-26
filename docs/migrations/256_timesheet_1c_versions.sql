-- Материализованные версии закрытых табелей + подтверждения выгрузки в 1С.
--
-- Задача: 1С должна забирать закрытый согласованный табель и понимать, что он
-- изменился. Табель нигде не хранится — часы считаются на лету из skud_daily_summary,
-- attendance_adjustments, графиков и производственного календаря. Поэтому «уже забрал»
-- и «забрал устаревшее» неразличимы, а фоновый пересчёт СКУД молча меняет часы уже
-- согласованного периода.
--
-- Решение: закрытый табель — неизменяемый официальный снимок. Версия создаётся при
-- approve и при каждом закрытии утверждённого периода (миграция 250 ввела временное
-- открытие через unlocked_at, статус при этом не меняется). API отдаёт табель только
-- из сохранённой версии и никогда не пересчитывает его.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ── 1. Версии табелей ───────────────────────────────────────────────────────
--
-- payload хранит канонический ответ целиком: состав, часы по дням, итоги. Именно он
-- отдаётся в 1С — не пересчёт. Оценка объёма: бригада ~150 КБ JSON, 855 подач ~130 МБ
-- до TOAST-сжатия.
--
-- Версии живут вместе с подачей (ON DELETE CASCADE); автоматической чистки нет —
-- это официальные снимки, они и должны храниться бессрочно.
CREATE TABLE IF NOT EXISTS timesheet_versions (
  id                  BIGSERIAL PRIMARY KEY,
  approval_id         BIGINT NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
  revision            INT NOT NULL,
  content_hash        TEXT NOT NULL,
  payload             JSONB NOT NULL,
  scope_kind          TEXT NOT NULL CHECK (scope_kind IN ('department', 'personal')),
  department_id       UUID NULL REFERENCES org_departments(id),
  manager_employee_id BIGINT NULL REFERENCES employees(id),
  start_date          DATE NOT NULL,
  end_date            DATE NOT NULL,
  employees_count     INT NOT NULL,
  total_hours         NUMERIC(10,2) NOT NULL,
  -- Окна членства по employee_id, зафиксированные в той же транзакции, что и расчёт.
  -- Нужны, чтобы перевод сотрудника в середине периода не переигрывался задним числом.
  membership_windows  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source              TEXT NOT NULL CHECK (source IN ('approve', 'close', 'backfill')),
  created_by          UUID NULL REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT timesheet_versions_revision_unique UNIQUE (approval_id, revision),
  CONSTRAINT timesheet_versions_range_check CHECK (end_date >= start_date),
  -- Тот же XOR, что у timesheet_approvals: подача либо отдела, либо персональная.
  CONSTRAINT timesheet_versions_scope_xor CHECK (
    (scope_kind = 'department' AND department_id IS NOT NULL AND manager_employee_id IS NULL)
    OR (scope_kind = 'personal' AND department_id IS NULL AND manager_employee_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_timesheet_versions_approval
  ON timesheet_versions (approval_id, revision DESC);

COMMENT ON TABLE timesheet_versions IS
  'Официальные снимки закрытых согласованных табелей. Создаются при approve и при '
  'закрытии утверждённого периода. Не пересчитываются: фоновые изменения СКУД на '
  'сохранённую версию не влияют.';
COMMENT ON COLUMN timesheet_versions.revision IS
  'Номер редакции в рамках подачи, 1..N. Если новый снимок совпал с предыдущим по '
  'content_hash, новая редакция НЕ создаётся — пустое открытие/закрытие не должно '
  'выглядеть как изменение.';
COMMENT ON COLUMN timesheet_versions.content_hash IS
  'md5 канонической сериализации всего payload, включая identity, zero_activity и итоги.';
COMMENT ON COLUMN timesheet_versions.payload IS
  'Канонический ответ для 1С целиком — весь согласованный состав, без фильтрации.';

-- ── 2. Подтверждения выгрузки от 1С ─────────────────────────────────────────
--
-- Ключ — сама версия, а не (approval_id, revision): при таком PK противоречивая
-- строка невозможна по построению, а approval_id/revision/content_hash читаются
-- джойном к timesheet_versions.
--
-- ACK глобальный, не per-key: API-ключ — это учётные данные, а не получатель табеля.
-- Ротация ключа не должна превращать уже принятую 1С версию в «не выгруженную».
-- key_id хранится ТОЛЬКО для аудита. Если появятся несколько независимых баз 1С,
-- вводится отдельный consumer_id — переиспользовать key_id для этого нельзя.
CREATE TABLE IF NOT EXISTS timesheet_1c_exports (
  version_id   BIGINT PRIMARY KEY REFERENCES timesheet_versions(id) ON DELETE CASCADE,
  key_id       UUID NULL REFERENCES data_api_keys(id) ON DELETE SET NULL,
  document_ref TEXT NULL,
  note         TEXT NULL,
  acked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE timesheet_1c_exports IS
  'Подтверждения приёма версии табеля в 1С. Идемпотентны: повторный ACK той же '
  'редакции не создаёт вторую строку и возвращает исходный acked_at.';
COMMENT ON COLUMN timesheet_1c_exports.key_id IS
  'Только аудит — каким ключом отправлено подтверждение. Состояние выгрузки от ключа '
  'не зависит.';

-- ── 3. Право ключа на подтверждение ─────────────────────────────────────────
-- POST /timesheets/{id}/ack — единственный пишущий метод публичного data-api,
-- поэтому он закрыт отдельным флагом, а не capability по таблицам.
ALTER TABLE data_api_keys
  ADD COLUMN IF NOT EXISTS allow_timesheet_ack BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN data_api_keys.allow_timesheet_ack IS
  'Разрешено ли ключу подтверждать выгрузку табелей (POST /api/public/v1/timesheets/*/ack).';

-- ── 4. Backfill снимков состава ─────────────────────────────────────────────
--
-- Версия строится по timesheet_approval_employees — «кто был в закрытом табеле».
-- У 7 старых утверждённых подач снимка нет (подавались до миграции 115), и без него
-- версию собрать не из чего.
--
-- Все 7 — подачи отдела (department_id IS NOT NULL), поэтому персональная ветка
-- (resolveManagerPersonalSnapshotIds: руководитель + прямые подчинённые за вычетом
-- покрытых подачей отдела) здесь не нужна. Если такие подачи появятся позже,
-- их добирает скрипт backfill-timesheet-versions.ts.
--
-- Состав восстанавливаем по членству в отделе, пересекающемуся с периодом подачи.
INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
SELECT DISTINCT a.id, e.id, COALESCE(e.full_name, '')
  FROM timesheet_approvals a
  JOIN employee_assignments ea
    ON ea.org_department_id = a.department_id
   AND ea.effective_from <= a.end_date
   AND (ea.effective_to IS NULL OR ea.effective_to >= a.start_date)
  JOIN employees e ON e.id = ea.employee_id
 WHERE a.status = 'approved'
   AND a.department_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM timesheet_approval_employees s WHERE s.approval_id = a.id
   )
ON CONFLICT (approval_id, employee_id) DO NOTHING;

-- Подачи, для которых состав так и не восстановился, остаются без снимка: API отдаст
-- по ним VERSION_NOT_AVAILABLE, а в списке они придут с version_available = false.
-- Молча выгрузить неполный табель нельзя.
--
-- Фактический результат на 2026-08 (проверено на проде): восстанавливаются 6 подач
-- из 7 — id 3, 4, 6, 9, 10, 11 (все за апрель 2026, то есть вне трёхмесячного окна API).
-- Не восстанавливается id 940 (01–15.07.2026, «Отдел главного энергетика»): ровно
-- 01.07 оба его сотрудника переведены в «Участок электромонтажных работ», и за период
-- подачи в отделе не числится никого. Это не дефект backfill — восстанавливать нечего,
-- подача пуста по существу. Такие случаи разбирает скрипт backfill-timesheet-versions.ts:
-- он выводит их отдельным списком, а признать подачу пустой (создать версию с нулевым
-- составом) можно только явным флагом --allow-empty-roster.

COMMIT;
