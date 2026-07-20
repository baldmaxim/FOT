-- 227_adaptive_llm_calls_cached.sql
-- Адаптивное тестирование: учёт кэшированных prompt-токенов в ledger.
--
-- Системный промпт и методичка отдела статичны в пределах сессии и уходят в
-- LLM одинаковым префиксом при каждом вызове. Провайдер может отдавать часть
-- prompt-токенов из кэша по цене чтения ~$0.10/1М против $1/1М за свежие.
-- Раньше usage парсился без cached_tokens — нельзя было понять, срабатывает ли
-- prefix-кэш через прокси. Колонка нужна для замера перед массовым запуском.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Требует применённых 224–226.

BEGIN;

ALTER TABLE adaptive_llm_calls
  ADD COLUMN IF NOT EXISTS cached_tokens INTEGER NOT NULL DEFAULT 0;

ALTER TABLE adaptive_llm_calls
  DROP CONSTRAINT IF EXISTS adaptive_llm_calls_cached_tokens_check;
ALTER TABLE adaptive_llm_calls
  ADD CONSTRAINT adaptive_llm_calls_cached_tokens_check CHECK (cached_tokens >= 0);

COMMENT ON COLUMN adaptive_llm_calls.cached_tokens IS
  'Сколько prompt-токенов вернулось из кэша провайдера (usage.prompt_tokens_details.cached_tokens); 0 — кэш не сработал или не проброшен прокси.';

NOTIFY pgrst, 'reload schema';

COMMIT;
