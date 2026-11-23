-- Откат 375: статусы выгрузки в ЗУП3 по половинам месяца.
--
-- Порядок: сначала вернуть бэкенд на версию до 375 (544db5e2 — статусы за месяц, таблицы 373), затем этот файл.
-- Подтверждения 1С по половинам (staff_month_1c_half_exports) удаляются вместе с таблицами — перед откатом
-- сохраните их, если они уже есть:
--   \copy (SELECT * FROM staff_month_1c_half_exports) TO 'staff_month_1c_half_exports.csv' CSV HEADER
-- Повторное применение 375 после отката безопасно: таблицы создадутся заново, ревизии соберёт фоновое обновление.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.staff_month_1c_half_exports') IS NOT NULL THEN
    RAISE NOTICE 'подтверждений 1С по половинам удаляется: %', (SELECT count(*) FROM staff_month_1c_half_exports);
  END IF;
END $$;

DROP TABLE IF EXISTS staff_month_1c_half_exports;
DROP TABLE IF EXISTS staff_month_1c_half_states;
DROP TABLE IF EXISTS staff_month_1c_half_revisions;
DROP TABLE IF EXISTS staff_month_1c_half_builds;

-- Без DELETE из schema_migrations раннер не применит 375 повторно.
DELETE FROM schema_migrations WHERE filename = '375_staff_month_1c_halves.sql';

COMMIT;
