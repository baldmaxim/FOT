-- N1.b session revocation: при смене system_role_id / employee_id у пользователя
-- инкрементируется token_version. JWT хранит token_version момента выпуска,
-- middleware/auth.ts сверяет его с актуальным значением — несовпадение даёт 401
-- "Token revoked". Клиент через api/client.ts ловит 401 → /auth/refresh →
-- новый токен с актуальным is_admin/role_code из БД.
--
-- Без этого после понижения роли пользователь до релогина или 7 дней истечения
-- JWT всё ещё проходит requireAdmin/requirePageAccess по старому is_admin=true
-- в payload (см. middleware/auth.ts:34-49 и access-control.service.ts:146).
--
-- DEFAULT 0 безопасен для существующих токенов: payload без token_version
-- декодируется как undefined → нормализуется в 0 → совпадает с fresh.

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;
