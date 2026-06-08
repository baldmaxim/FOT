-- 172_contractor_activation_batches.sql
-- Серверно-авторитетный батч активации пропусков подрядчика: при «Открыть пропуска»
-- сервер сохраняет набор только что активированных профилей Sigur (PROTECTED — их
-- НИКОГДА нельзя заблокировать) и allow-list найденных дублей-однофамильцев (candidates).
-- Модалка ссылается только на batch_id; блокировка дубля разрешена лишь для строки из
-- candidates и запрещена для activated_sigur_ids. Записи живут сутки (TTL-очистка при вставке).

CREATE TABLE IF NOT EXISTS contractor_activation_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES contractor_submissions(id),
  created_by    uuid NOT NULL REFERENCES user_profiles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Только что активированные профили Sigur — защищены от блокировки.
  activated_sigur_ids bigint[] NOT NULL DEFAULT '{}',
  -- Найденные дубли (полная инфа строкой: source/pass_id/employee_id/card_uid/...).
  candidates    jsonb NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS contractor_activation_batches_created_at_idx
  ON contractor_activation_batches(created_at);
