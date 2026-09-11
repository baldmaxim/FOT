-- 274: служебные записки к записям чёрного списка.
--
-- Зачем: в записи ЧС есть только короткая «Причина». Нужен подписанный документ
-- (скан, PDF, Word), который спустя время можно открыть и прочитать.
--
-- Почему не общая таблица documents (проверено на проде):
--   * documents.uploaded_by -> user_profiles ON DELETE CASCADE: удаление учётки
--     загрузившего унесло бы строку документа — то есть само доказательство;
--   * documents.employee_id выводит документ в кадровые списки и «Мои документы»
--     сотрудника — записка о его внесении в ЧС не должна попасть к нему в ЛК;
--   * documents.category -> FK на общий справочник категорий.
-- Файлы при этом лежат в том же R2 (префикс blacklist/), новое хранилище не заводим.
--
-- Идемпотентность держится на sha256 содержимого: одна активная записка на
-- (запись, файл). Ключ R2 детерминирован (blacklist/<entryId>/<sha256><ext>),
-- поэтому повторная загрузка перезаписывает тот же объект тем же содержимым.
-- Сирота возможна только в одном случае: объект ушёл в R2, транзакция БД упала и
-- запрос не повторили. Данные не теряются; такие объекты находит read-only отчёт
-- fot-server/scripts/report-blacklist-memo-orphans.ts, удаление — только вручную.
--
-- Только CREATE ... IF NOT EXISTS: существующие таблицы не меняются,
-- повторный запуск безопасен. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА, после 273.

BEGIN;

CREATE TABLE IF NOT EXISTS public.person_blacklist_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT, а не CASCADE: записи ЧС не удаляются (снятие мягкое), но если запись
  -- попытаются удалить SQL-ом, база не даст молча унести записки вместе с ней.
  blacklist_id uuid NOT NULL REFERENCES public.person_blacklist(id) ON DELETE RESTRICT,
  file_name text NOT NULL,
  file_size integer NOT NULL CHECK (file_size > 0),
  -- MIME, определённый сервером по сигнатуре файла, а не присланный клиентом.
  mime_type text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- НЕ unique: после мягкого удаления тот же файл можно приложить снова новой строкой,
  -- и она сошлётся на тот же объект R2.
  r2_key text NOT NULL,
  -- SET NULL + снимок имени: удаление учётки не уносит записку и не стирает автора.
  uploaded_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  uploaded_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Удаление мягкое: ошибочно приложенный файл скрывается, объект в R2 и след остаются.
  deleted_at timestamptz,
  deleted_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  deleted_by_name text,
  CONSTRAINT person_blacklist_memos_deleted_ck CHECK (
    (deleted_at IS NULL AND deleted_by_name IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by_name IS NOT NULL))
);

COMMENT ON TABLE public.person_blacklist_memos IS
  'Служебные записки (файлы в R2) к записям чёрного списка. Одна активная записка на (запись, sha256). Удаление мягкое, объекты R2 не удаляются.';

CREATE INDEX IF NOT EXISTS person_blacklist_memos_entry_idx
  ON public.person_blacklist_memos(blacklist_id, created_at DESC) WHERE deleted_at IS NULL;

-- Один и тот же файл — одна активная записка на запись: защищает от двойного
-- клика, повтора запроса после обрыва сети и параллельной загрузки одного файла.
CREATE UNIQUE INDEX IF NOT EXISTS person_blacklist_memos_active_file_uq
  ON public.person_blacklist_memos(blacklist_id, sha256) WHERE deleted_at IS NULL;

-- Отчёт о сиротах ищет строки по ключу, в том числе среди мягко удалённых.
CREATE INDEX IF NOT EXISTS person_blacklist_memos_r2_key_idx
  ON public.person_blacklist_memos(r2_key);

COMMIT;
