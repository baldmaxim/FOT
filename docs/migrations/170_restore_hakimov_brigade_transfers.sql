-- 170: Восстановление пятерых уволенных в табеле бр.Хакимов А.А. за май 2026.
-- Переведены из бр.Абдуллоева Д.Х. в бр.Хакимов А.А. 03.05, отработали несколько дней, уволены.
-- Перевод в Хакимова не попал в Sigur-синк до увольнения → в FOT не зафиксирован: единственная
-- строка employee_assignments указывает на «Уволенные» (артефакт freeze), у 4 из 5 dismissal_date NULL.
-- Бригаду Хакимова подтвердил пользователь (в данных след только бр.Абдуллоева).
-- Идемпотентно (повторный прогон не дублирует и не ломает уже исправленное).
--   id   ФИО                                период (вход 03.05)
--   267  Бегбаев Бегзод Жамшидович          → 12.05
--   719  Исматов Жонибек Абдумалик Угли     → 12.05
--   1237 Набиев Худойберди Абдувоситович    → 12.05
--   1340 Олимов Дилшод Парпиевич            → 18.05 (dismissal_date уже 22.05 — не трогаем)
--   1691 Сохибов Алиджон Улмасович          → 13.05

BEGIN;

-- 1) Перенацеливаем единственное назначение → бр.Хакимов [03.05 → последний день].
--    Guard: у сотрудника РОВНО одна строка назначения и она указывает на «Уволенные»
--    (либо уже на Хакимова — для идемпотентности).
UPDATE employee_assignments a
   SET org_department_id = 'b1de3060-f414-48a0-8080-5a47cbaa2c80',
       effective_from    = DATE '2026-05-03',
       effective_to      = v.last_day,
       change_reason     = 'Восстановление перевода в бр.Хакимов (миграция 170)',
       updated_at        = now()
  FROM (VALUES
    (267,  DATE '2026-05-12'),
    (719,  DATE '2026-05-12'),
    (1237, DATE '2026-05-12'),
    (1340, DATE '2026-05-18'),
    (1691, DATE '2026-05-13')
  ) AS v(employee_id, last_day)
 WHERE a.employee_id = v.employee_id
   AND a.org_department_id IN (
         'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc',  -- Уволенные (артефакт)
         'b1de3060-f414-48a0-8080-5a47cbaa2c80'   -- Хакимов (повторный прогон)
       )
   AND (SELECT count(*) FROM employee_assignments x WHERE x.employee_id = a.employee_id) = 1;

-- 2) Проставляем dismissal_date = последний рабочий день там, где NULL (Олимов уже имеет 22.05).
--    Нужно, чтобы фильтр уволенных в табеле (dismissal_date IS NOT NULL AND >= startDate) их пропускал.
UPDATE employees e
   SET dismissal_date = v.last_day,
       updated_at     = now()
  FROM (VALUES
    (267,  DATE '2026-05-12'),
    (719,  DATE '2026-05-12'),
    (1237, DATE '2026-05-12'),
    (1340, DATE '2026-05-18'),
    (1691, DATE '2026-05-13')
  ) AS v(employee_id, last_day)
 WHERE e.id = v.employee_id
   AND e.dismissal_date IS NULL;

-- 3) Событие увольнения: переводим from_department_id на Хакимова (у Олимова сейчас Абдуллоев),
--    чтобы уволенный не отображался ошибочно ещё и в табеле бр.Абдуллоева.
UPDATE employee_dismissal_events
   SET from_department_id = 'b1de3060-f414-48a0-8080-5a47cbaa2c80'
 WHERE employee_id IN (267, 719, 1237, 1340, 1691)
   AND from_department_id IS DISTINCT FROM 'b1de3060-f414-48a0-8080-5a47cbaa2c80';

-- Проверка: все пятеро должны иметь назначение в бр.Хакимов на целевые даты.
DO $$
DECLARE matched int;
BEGIN
  SELECT count(*) INTO matched
    FROM employee_assignments a
    JOIN (VALUES
      (267,  DATE '2026-05-12'),
      (719,  DATE '2026-05-12'),
      (1237, DATE '2026-05-12'),
      (1340, DATE '2026-05-18'),
      (1691, DATE '2026-05-13')
    ) AS v(employee_id, last_day) ON v.employee_id = a.employee_id
   WHERE a.org_department_id = 'b1de3060-f414-48a0-8080-5a47cbaa2c80'
     AND a.effective_from = DATE '2026-05-03'
     AND a.effective_to   = v.last_day;
  IF matched <> 5 THEN
    RAISE EXCEPTION '170: ожидалось 5 назначений в бр.Хакимов на целевые даты, получено % — проверьте назначения вручную', matched;
  END IF;
  RAISE NOTICE '170: восстановлено в бр.Хакимов = % (ожид. 5)', matched;
END $$;

COMMIT;
