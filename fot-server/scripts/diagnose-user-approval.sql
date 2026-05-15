-- Read-only диагностика: «одобренный пользователь видит "Ожидание одобрения"
-- при входе». Только SELECT-ы, БД не изменяется.
--
-- Запускать на ПРОД Yandex PG (локальный .env указывает на старую Supabase!):
--   psql "<PROD_DATABASE_URL>" -v email="'shadrov.s.i@mstroy.pro'" -v surname="'%shadrov%'" -f scripts/diagnose-user-approval.sql
--
-- :email   — точный email (case-insensitive)
-- :surname — LIKE-шаблон по фамилии в email/ФИО (например '%shadrov%')

\echo '=== 1. app_auth.users (по email и фамилии) ==='
SELECT id, email, email_confirmed_at, created_at
FROM app_auth.users
WHERE lower(email) = lower(:email)
   OR lower(email) LIKE lower(:surname)
ORDER BY created_at;

\echo '=== 2. user_profiles (login-строка + по ФИО) + JOIN на auth ==='
-- auth_id IS NULL  → ORPHAN-профиль без app_auth.users (вход по нему невозможен)
-- is_approved=false на строке с auth_id → именно из-за неё редирект на /pending-approval
SELECT up.id            AS profile_id,
       up.full_name,
       up.is_approved,
       up.approved_at,
       up.approved_by,
       sr.code           AS role_code,
       up.employee_id,
       up.two_factor_enabled,
       up.created_at,
       au.id             AS auth_id,
       au.email          AS auth_email,
       au.email_confirmed_at
FROM user_profiles up
LEFT JOIN app_auth.users au ON au.id = up.id
LEFT JOIN system_roles  sr ON sr.id = up.system_role_id
WHERE up.full_name ILIKE :surname
   OR up.full_name ILIKE '%шадров%'
   OR up.id IN (
        SELECT id FROM app_auth.users
        WHERE lower(email) = lower(:email) OR lower(email) LIKE lower(:surname)
   )
ORDER BY up.created_at;

\echo '=== 3. audit_logs (USER_APPROVED / USER_REJECTED / USER_DELETED) ==='
-- Пусто → одобрение фактически не выполнялось (случай A).
SELECT created_at, action, entity_id, user_id, details
FROM audit_logs
WHERE action IN ('USER_APPROVED','USER_REJECTED','USER_DELETED')
  AND entity_id::text IN (
        SELECT id::text FROM app_auth.users
          WHERE lower(email) = lower(:email) OR lower(email) LIKE lower(:surname)
        UNION
        SELECT up.id::text FROM user_profiles up
          WHERE up.full_name ILIKE :surname OR up.full_name ILIKE '%шадров%'
  )
ORDER BY created_at DESC;
