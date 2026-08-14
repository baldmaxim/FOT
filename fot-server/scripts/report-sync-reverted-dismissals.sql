-- Отчёт-реконструкция: сотрудники с неотменённым увольнением, которые сейчас числятся
-- активными без dismissal_date. Инцидент 10–13.08.2026: синк Sigur «реактивировал»
-- уволенных, пока `sigur_archive_department_id` пустовал.
--
-- Только чтение. Последнее кадровое действие восстанавливается ОДНОВРЕМЕННО по
-- employee_dismissal_events и audit_logs; расхождение между источниками видно в колонке
-- source_conflict — такие строки разбираются вручную, автоправкой их трогать нельзя.
--
-- Запуск (вывод в CSV для кадровой сверки):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --csv -f scripts/report-sync-reverted-dismissals.sql > reverted-dismissals.csv

\set archive_dept_id '''ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'''

WITH archive AS (
  SELECT COALESCE(
    (SELECT value::uuid FROM system_settings WHERE key = 'employees_archive_department_id'),
    :archive_dept_id::uuid
  ) AS id
),
last_ev AS (
  SELECT DISTINCT ON (employee_id)
         employee_id, created_at, dismissal_date, scheduled, cancelled, rehired,
         applied_from_scheduled, from_department_id
    FROM employee_dismissal_events
   ORDER BY employee_id, created_at DESC
),
last_audit AS (
  SELECT DISTINCT ON (entity_id::int)
         entity_id::int AS employee_id, created_at, action
    FROM audit_logs
   WHERE entity_type = 'employee'
     AND entity_id ~ '^[0-9]+$'
     -- FIRE_EMPLOYEE_SCHEDULED обязателен: без него повторно назначенное увольнение теряется.
     AND action IN ('FIRE_EMPLOYEE', 'FIRE_EMPLOYEE_SCHEDULED', 'FIRE_EMPLOYEE_APPLIED',
                    'CANCEL_EMPLOYEE_DISMISSAL', 'REHIRE_EMPLOYEE')
   ORDER BY entity_id::int, created_at DESC
),
cand AS (
  SELECT e.id,
         e.full_name,
         d.name AS current_department,
         ev.dismissal_date AS event_dismissal_date,
         ev.created_at     AS event_at,
         ev.scheduled,
         ev.cancelled,
         ev.rehired,
         ev.applied_from_scheduled,
         a.action     AS audit_action,
         a.created_at AS audit_at,
         e.dismissal_apply_started_at IS NOT NULL AS has_stale_claim
    FROM employees e
    JOIN last_ev ev ON ev.employee_id = e.id
    LEFT JOIN last_audit a ON a.employee_id = e.id
    LEFT JOIN org_departments d ON d.id = e.org_department_id
   WHERE e.employment_status = 'active'
     AND e.dismissal_date IS NULL
),
enriched AS (
  SELECT c.*,
         (SELECT count(*) FROM employee_assignments x
           WHERE x.employee_id = c.id AND x.effective_to IS NULL
             AND x.org_department_id <> (SELECT id FROM archive))            AS open_outside_archive,
         (SELECT count(*) FROM employee_assignments x
           WHERE x.employee_id = c.id AND x.effective_to IS NULL
             AND x.org_department_id = (SELECT id FROM archive))             AS open_in_archive,
         (SELECT min(x.effective_from) FROM employee_assignments x
           WHERE x.employee_id = c.id AND x.effective_to IS NULL
             AND x.org_department_id <> (SELECT id FROM archive))            AS open_outside_from,
         (SELECT string_agg(DISTINCT x.change_reason, ' | ') FROM employee_assignments x
           WHERE x.employee_id = c.id AND x.effective_to IS NULL
             AND x.org_department_id <> (SELECT id FROM archive))            AS open_outside_reason,
         (SELECT count(*) FROM employee_department_access x
           WHERE x.employee_id = c.id AND x.is_active)                       AS active_department_access,
         -- Проходы после даты увольнения = человек фактически работал. Такие строки
         -- нельзя «довосстанавливать» автоматически, даже если всё остальное сходится.
         (SELECT count(*) FROM skud_events s
           WHERE s.employee_id = c.id AND s.event_date > c.event_dismissal_date) AS badging_after_dismissal,
         (SELECT max(s.event_date) FROM skud_events s
           WHERE s.employee_id = c.id AND s.event_date > c.event_dismissal_date) AS last_badging_after_dismissal
    FROM cand c
)
SELECT
  id,
  full_name,
  current_department,
  event_dismissal_date,
  event_at,
  CASE
    WHEN rehired   THEN 'event:rehired'
    WHEN cancelled THEN 'event:cancelled'
    WHEN applied_from_scheduled THEN 'event:applied_by_scheduler'
    WHEN scheduled THEN 'event:scheduled'
    ELSE 'event:fired'
  END AS last_event_kind,
  audit_action,
  audit_at,
  -- Источники расходятся → строка идёт только на ручную сверку.
  CASE
    WHEN (rehired OR cancelled) AND audit_action LIKE 'FIRE%' THEN true
    WHEN NOT (rehired OR cancelled)
         AND audit_action IN ('REHIRE_EMPLOYEE', 'CANCEL_EMPLOYEE_DISMISSAL') THEN true
    ELSE false
  END AS source_conflict,
  has_stale_claim,
  open_outside_archive,
  open_in_archive,
  open_outside_from,
  open_outside_reason,
  -- Подсказка по алгоритму назначений в repair-скрипте.
  CASE
    WHEN open_outside_archive = 0 AND open_in_archive > 0 THEN 'archive_open_only'
    WHEN open_outside_archive > 0 AND open_outside_from <= event_dismissal_date THEN 'close_by_D'
    WHEN open_outside_archive > 0 AND open_outside_from > event_dismissal_date THEN 'starts_after_D_review'
    ELSE 'no_open_assignment'
  END AS assignment_case,
  active_department_access,
  badging_after_dismissal,
  last_badging_after_dismissal
FROM enriched
ORDER BY badging_after_dismissal, event_at DESC;
