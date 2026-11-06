-- 349: автоблокировка пропусков подрядчиков, которые не ходят больше 5 дней.
-- Применять ДО деплоя бэкенда: статистика, «Мониторинг» и кабинет подрядчика читают новые колонки.
--
-- Состояние лежит на строке держателя: новый держатель получает новую строку и ничего не наследует.
--   idle_blocked_at          — сервис сам заблокировал профиль или записал причину автоблокировки;
--   external_blocked_seen_at — профиль уже был заблокирован с чужой причиной, сервис только снял активность;
--   idle_block_failed_at     — последняя ошибка обработки: такие строки идут в конец очереди,
--                              чтобы одни и те же пропуска не держали прогон.
--
-- Сама миграция никого не блокирует: ночной прогон выключен (kill switch ниже), включается
-- отдельно после ручной обработки начальной очереди: scripts/contractor-pass-idle-block.ts --nightly on.
-- Идемпотентно.

ALTER TABLE public.contractor_pass_holders
  ADD COLUMN IF NOT EXISTS idle_blocked_at timestamptz,
  ADD COLUMN IF NOT EXISTS external_blocked_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS idle_block_failed_at timestamptz;

INSERT INTO system_settings (key, value, description, is_secret)
VALUES
  ('contractor_pass_idle_block_enabled', 'false',
   'Подрядчики: ночная автоблокировка пропусков без проходов больше 5 дней (kill switch).', false)
ON CONFLICT (key) DO NOTHING;
