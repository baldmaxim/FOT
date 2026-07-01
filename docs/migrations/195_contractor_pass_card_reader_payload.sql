-- 195_contractor_pass_card_reader_payload.sql
-- Полный payload ридера карты (JSONB) — для будущего анализа ошибок и дедупа.
--
-- Зачем: card_uid хранит только 24-битный W26 (легко коллидирует), card_hex_uid
-- (мигр. 194) — полный CSN. Здесь сохраняем ВСЁ, что отдаёт ридер-агент
-- (w26, sigurCard, hexUid, decBe, decLe, rawHex) как есть, чтобы задним числом
-- разбирать причины дублей/коллизий и при необходимости достроить более точный ключ
-- без новых миграций. Заполняется только для НОВЫХ выдач; старые пропуска — NULL.

BEGIN;

ALTER TABLE public.contractor_passes
  ADD COLUMN IF NOT EXISTS card_reader_payload jsonb NULL;

COMMENT ON COLUMN public.contractor_passes.card_reader_payload IS
  'Сырой payload ридера при выдаче карты (w26/sigurCard/hexUid/decBe/decLe/rawHex) для анализа коллизий. NULL для карт до миграции 195.';

COMMIT;
