-- 226_adaptive_llm_calls_extract.sql
-- Адаптивное тестирование: компетенции профиля определяются по .md-файлу.
--
-- Админ больше не вводит обязанности и компетенции руками — единственный
-- источник содержания профиля — загруженная методичка. При сохранении профиля
-- сервер один раз просит Luna выделить из файла проверяемые темы, поэтому в
-- ledger LLM-вызовов появляется новое назначение 'extract_competencies'.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Требует применённых 224 и 225.

BEGIN;

ALTER TABLE adaptive_llm_calls
  DROP CONSTRAINT IF EXISTS adaptive_llm_calls_purpose_check;
ALTER TABLE adaptive_llm_calls
  ADD CONSTRAINT adaptive_llm_calls_purpose_check
  CHECK (purpose IN ('generate', 'evaluate', 'health_check', 'extract_competencies'));

COMMENT ON COLUMN adaptive_llm_calls.purpose IS
  'Назначение вызова: generate — вопрос, evaluate — оценка ответа, health_check — проверка связи, extract_competencies — разбор .md профиля на темы.';

NOTIFY pgrst, 'reload schema';

COMMIT;
