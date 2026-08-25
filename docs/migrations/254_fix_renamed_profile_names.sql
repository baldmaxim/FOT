-- Миграция 254: привести ФИО профилей портала к карточкам для пяти сменивших фамилию.
--
-- Зачем: user_profiles.full_name — отдельная копия ФИО (вписывается при регистрации), её
-- показывают ЛК, чат, аудит и история заявлений. Смена фамилии в Sigur меняла только
-- employees.full_name, поэтому в ЛК оставалась девичья фамилия (инцидент 25.08.2026).
-- Код-зеркало (user-profile-name.service.ts) чинит это на будущее; здесь — разовый фикс
-- уже накопленных случаев.
--
-- Осознанно НЕ выравниваем все 272 исторических расхождения (CAPS, порядок слов, опечатки
-- транслита в самозаписи) — только пять подтверждённых смен фамилии.
--
-- Идемпотентна: повторный запуск ничего не меняет и не падает.

BEGIN;

-- Preflight ДО изменений: ровно пять ожидаемых пар «старая → новая фамилия», каноническое
-- имя непустое. Если данные разошлись с планом — не трогаем ничего.
DO $$
DECLARE matched int;
BEGIN
  WITH expected(employee_id, old_surname, new_surname) AS (
    VALUES (396,  'Виноходова', 'Чернышева'),
           (459,  'Голубева',   'Ткачёва'),
           (749,  'Калитуха',   'Перчемли'),
           (1457, 'Аллахярова', 'Разаханова'),
           (8890, 'Петрова',    'Аксенова- Шукурзаде')
  )
  SELECT count(*) INTO matched
  FROM expected x
  JOIN user_profiles up ON up.employee_id = x.employee_id
  JOIN employees e      ON e.id = up.employee_id
  WHERE (split_part(btrim(up.full_name), ' ', 1) = x.old_surname
         OR btrim(up.full_name) = btrim(e.full_name))
    AND btrim(e.full_name) LIKE x.new_surname || '%'
    AND btrim(coalesce(e.full_name, '')) <> '';

  IF matched <> 5 THEN
    RAISE EXCEPTION 'migration 254: ожидалось 5 совпадений, найдено % — данные разошлись с планом', matched;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS migration_254_backup (
  profile_id    uuid PRIMARY KEY,
  employee_id   bigint NOT NULL,
  old_full_name text,
  new_full_name text,
  backed_up_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO migration_254_backup (profile_id, employee_id, old_full_name, new_full_name)
SELECT up.id, up.employee_id, up.full_name, btrim(e.full_name)
FROM user_profiles up
JOIN employees e ON e.id = up.employee_id
WHERE up.employee_id IN (396, 459, 749, 1457, 8890)
  AND btrim(coalesce(up.full_name, '')) IS DISTINCT FROM btrim(e.full_name)
  AND btrim(coalesce(e.full_name, '')) <> ''
ON CONFLICT (profile_id) DO NOTHING;

-- Виноходова→Чернышева, Голубева→Ткачёва, Калитуха→Перчемли,
-- Аллахярова→Разаханова, Петрова→Аксенова-Шукурзаде
UPDATE user_profiles up
SET full_name = btrim(e.full_name)
FROM employees e
WHERE e.id = up.employee_id
  AND up.employee_id IN (396, 459, 749, 1457, 8890)
  AND btrim(coalesce(up.full_name, '')) IS DISTINCT FROM btrim(e.full_name)
  AND btrim(coalesce(e.full_name, '')) <> '';

-- Postflight: расхождений по этим пяти остаться не должно.
DO $$
DECLARE left_over int;
BEGIN
  SELECT count(*) INTO left_over
  FROM user_profiles up
  JOIN employees e ON e.id = up.employee_id
  WHERE up.employee_id IN (396, 459, 749, 1457, 8890)
    AND btrim(coalesce(up.full_name, '')) IS DISTINCT FROM btrim(e.full_name);

  IF left_over > 0 THEN
    RAISE EXCEPTION 'migration 254: остались расхождения (%)', left_over;
  END IF;
END $$;

COMMIT;

-- Откат (выполнять отдельно). Строки, где имя успели изменить после миграции, пропускаются:
-- их состояние новее бэкапа.
--
-- BEGIN;
-- UPDATE user_profiles up
-- SET full_name = b.old_full_name
-- FROM migration_254_backup b
-- WHERE b.profile_id = up.id
--   AND btrim(coalesce(up.full_name, '')) = btrim(coalesce(b.new_full_name, ''));
-- COMMIT;
