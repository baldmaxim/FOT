-- 265: уникальность и целостность фильтра синхронизации отделов Sigur.
-- Применять ДО деплоя бэкенда.
--
-- До этого skud_sync_department_filter переписывался как DELETE-all + INSERT вне
-- транзакции (sigur-filter.controller.updateFilter и persistSyncFilterRows). Обрыв
-- между шагами оставлял пустой whitelist, а пустой whitelist означает «ничего не
-- синхронизируем» (skud-shared.service.ts) и реконсиляцию, гасящую все sigur-отделы.
-- Уникальный индекс позволяет заменить перезапись идемпотентным upsert + diff.

BEGIN;

-- Строки без sigur-id не участвуют в фильтрации и мешают NOT NULL.
DELETE FROM public.skud_sync_department_filter
 WHERE sigur_department_id IS NULL;

-- Дедупликация: оставляем самую раннюю строку по каждому sigur_department_id.
DELETE FROM public.skud_sync_department_filter a
 USING public.skud_sync_department_filter b
 WHERE a.sigur_department_id = b.sigur_department_id
   AND a.id > b.id;

ALTER TABLE public.skud_sync_department_filter
  ALTER COLUMN sigur_department_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_skud_sync_department_filter_sigur
  ON public.skud_sync_department_filter (sigur_department_id);

COMMIT;
