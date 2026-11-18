-- 369: Плановые доплаты — несколько одновременных доплат у сотрудника.
--
-- Зачем. У сотрудника бывают разные плановые доплаты на один и тот же период (за руководство объектом, за
-- совмещение…) — у каждой свой комментарий. Журнал 293 этого не умел: более поздняя строка, пересекающая по датам
-- более раннюю, скрывала её целиком, поэтому «Добавить сотрудника» отвечал 409 «уже есть доплата в эти даты».
--
-- Новая модель: каждая неархивная строка с суммой — самостоятельная действующая доплата, перекрытия ничего не
-- скрывают. Правка строки — архив её и новая строка с replaces_id, снятие — архив и архивная строка «снята» с
-- replaces_id (как у 337). Расчёт ФОТ уже считает каждый период отдельно и складывает — его не меняем.
--
-- Что делает миграция (одной транзакцией):
--   1. Нормализация — только при первом запуске (колонки legacy_journal ещё нет). Неархивные строки, которых нет среди
--      действующих периодов по прежнему правилу (перекрытые более поздней строкой, «снята» и строка перед «снята»),
--      уходят в архив. Затем множество действующих периодов сверяется: по новому правилу (неархивные с суммой) — то же,
--      что по прежнему, иначе откат. Повторный запуск после нового бэкенда нормализацию не повторяет: она заархивировала
--      бы законные одновременные доплаты.
--   2. legacy_journal: у существующих строк true — в «Истории изменений» их «было» по-прежнему из предыдущей строки
--      журнала; новый бэкенд пишет false явно, «было» — только по replaces_id. DEFAULT true оставлен намеренно (п. 3).
--   3. Триггер: вставка без legacy_journal = false (прежний бэкенд, старые скрипты — колонку не знают) отклоняется.
--      Прежний бэкенд дописывал версию без архивации предыдущей — новый счёл бы обе строки действующими. Поэтому между
--      миграцией и новым бэкендом запись плановых доплат старым кодом невозможна (ошибка, данные не портятся);
--      сохранение условий без правки доплаты проходит — оно в журнал не пишет.
--
-- Прежний бэкенд на нормализованных данных читает те же периоды (перекрытых и «снята» среди неархивных нет).
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА, бэкенд — сразу после. Повторный запуск безопасен.

BEGIN;

DO $$
DECLARE
  diff INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payroll_planned_supplements' AND column_name = 'legacy_journal'
  ) THEN
    RETURN;
  END IF;

  -- Действующие периоды по прежнему правилу (PLANNED_SUPPLEMENT_PERIODS_SQL до 369).
  CREATE TEMP TABLE pps_369_periods ON COMMIT DROP AS
  SELECT v.id, v.amount, v.date_from, v.date_to
    FROM (
      SELECT x.id, x.employee_id, x.amount, x.date_from, x.date_to,
             x.id = max(x.id) OVER (PARTITION BY x.employee_id) AS is_current,
             lead(x.amount IS NULL) OVER (PARTITION BY x.employee_id ORDER BY x.id) AS next_removed
        FROM payroll_planned_supplements x
       WHERE x.archived_at IS NULL
    ) v
   WHERE v.amount IS NOT NULL
     AND (v.is_current OR (
           v.next_removed IS NOT TRUE
           AND NOT EXISTS (
             SELECT 1 FROM payroll_planned_supplements y
              WHERE y.employee_id = v.employee_id
                AND y.archived_at IS NULL
                AND y.id > v.id
                AND y.amount IS NOT NULL
                AND daterange(y.date_from, y.date_to, '[]') && daterange(v.date_from, v.date_to, '[]'))));

  ALTER TABLE payroll_planned_supplements ADD COLUMN legacy_journal BOOLEAN NOT NULL DEFAULT true;

  UPDATE payroll_planned_supplements
     SET archived_at = now()
   WHERE archived_at IS NULL
     AND id NOT IN (SELECT id FROM pps_369_periods);

  SELECT count(*) INTO diff
    FROM (
      (SELECT id, amount, date_from, date_to FROM pps_369_periods
       EXCEPT
       SELECT id, amount, date_from, date_to FROM payroll_planned_supplements
        WHERE archived_at IS NULL AND amount IS NOT NULL)
      UNION ALL
      (SELECT id, amount, date_from, date_to FROM payroll_planned_supplements
        WHERE archived_at IS NULL AND amount IS NOT NULL
       EXCEPT
       SELECT id, amount, date_from, date_to FROM pps_369_periods)
    ) d;
  IF diff > 0 THEN
    RAISE EXCEPTION '369: действующие периоды плановых доплат изменились после нормализации (% расхождений)', diff;
  END IF;
END $$;

COMMENT ON COLUMN payroll_planned_supplements.legacy_journal IS
  'Строка журнала до 369: в истории «было» — предыдущая строка по id. Новые строки пишутся с false: «было» — '
  'только по replaces_id. DEFAULT true — вставку старым кодом отклоняет триггер.';

CREATE OR REPLACE FUNCTION payroll_planned_supplements_block_legacy() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Плановые доплаты обновляются — повторите через минуту'
    USING ERRCODE = 'object_not_in_prerequisite_state',
          DETAIL = 'payroll_planned_supplements: вставка без legacy_journal = false (код до миграции 369)';
END;
$$;

DROP TRIGGER IF EXISTS payroll_planned_supplements_block_legacy ON payroll_planned_supplements;
CREATE TRIGGER payroll_planned_supplements_block_legacy
  BEFORE INSERT ON payroll_planned_supplements
  FOR EACH ROW
  WHEN (NEW.legacy_journal)
  EXECUTE FUNCTION payroll_planned_supplements_block_legacy();

COMMENT ON TABLE payroll_planned_supplements IS
  'Плановые доплаты сотрудника. С миграции 369 каждая неархивная строка с суммой — самостоятельная действующая '
  'доплата (несколько на одни даты — можно); правка — архив строки и новая с replaces_id, снятие — архив и архивная '
  'строка «снята». Архивные — только история.';

COMMIT;
