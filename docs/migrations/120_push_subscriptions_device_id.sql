-- 120_push_subscriptions_device_id.sql
--
-- Дубли системных push-уведомлений: на один браузер приходило 2+ уведомления.
--
-- push_subscriptions имела UNIQUE только по (user_id, endpoint). Браузер
-- периодически ротирует push-endpoint — фронт сохранял новую подписку как
-- НОВУЮ строку, старая не удалялась (чистится лишь при HTTP 404/410). Пока
-- старый endpoint ещё жив, sendGenericNotification (SELECT ... WHERE user_id =
-- ANY(...)) слал push на каждую строку → один браузер получал 2+ push.
--
-- Решение: колонка device_id (стабильный id браузера из localStorage). При
-- ротации endpoint обновляется та же строка (см. push.service.saveSubscription),
-- накопления нет. Здесь: добавляем колонку, чистим текущие дубли (оставляем
-- новейшую подписку на пользователя — устройства перерегистрируются сами при
-- следующей загрузке) и ставим частичный UNIQUE-индекс (user_id, device_id).
--
-- Идемпотентно: IF NOT EXISTS на колонке и индексе.

BEGIN;

ALTER TABLE push_subscriptions
  ADD COLUMN IF NOT EXISTS device_id text;

-- Удаляем накопившиеся устаревшие подписки: оставляем по одной (новейшей)
-- строке на пользователя. Действующие устройства пере-сохранят свою подписку
-- с device_id при ближайшей загрузке приложения.
DELETE FROM push_subscriptions
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id) id
  FROM push_subscriptions
  ORDER BY user_id, created_at DESC
);

-- Частичный UNIQUE: legacy-строки с device_id IS NULL не конфликтуют между
-- собой, новые строки уникальны в разрезе (user_id, device_id).
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_device_uidx
  ON push_subscriptions (user_id, device_id)
  WHERE device_id IS NOT NULL;

COMMIT;
