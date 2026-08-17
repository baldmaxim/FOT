-- ============================================================================
-- Миграция 245: слияние дублей, порождённых сменой карточки Sigur
-- ============================================================================
--
-- Симптом (14.08.2026, бр.Прозорова А.В. и бр.Амонова М.Н.): человек стоит в
-- табеле двумя строками. Один тик syncEmployees увидел старую карточку Sigur в
-- архивной папке и новую карточку того же человека в рабочем отделе и оформил
-- это как «увольнение + приём нового сотрудника»:
--
--   Шарипов Исмоилджон Нуруллоевич: 2568 (sigur 143276, таб. 05919) → дубль 13403 (sigur 125698)
--   Мустафаев Уктам Мустафаевич:    2550 (sigur 143271, таб. 05967) → дубль 13404 (sigur 142215)
--
-- ПРАВИЛО СЛИЯНИЯ: остаётся старый FOT-профиль со всеми кадровыми данными,
-- табельным номером и исходной hire_date. От дубля берутся ТОЛЬКО новый Sigur ID,
-- актуальный отдел и должность. Любое иное непустое отличие в дубле (документы,
-- оклад, гражданство и т.п.) останавливает миграцию — такие случаи разбираются руками.
--
-- ПРЕДУСЛОВИЯ:
--   1) задеплоен бэкенд с rebind-гардом (planSigurCardRebinds/applySigurCardRebind,
--      сохранение tab_number, is_archived-гард, cancelled-фильтр) — иначе ближайший
--      тик синка пересоздаст дубли;
--   2) сделан снапшот/бэкап БД;
--   3) остановлены ВСЕ экземпляры бэкенда: web/cluster-воркеры, presence-polling,
--      sigur-monitor и все планировщики. Presence-polling кэширует sigurId → employee_id
--      на 10 минут и привязал бы свежие проходы к удаляемому профилю. Проходы не
--      теряются — поллинг курсорный и доберёт их после старта;
--   4) min_total_events (619 и 1193, снято 17.08.2026) — это МИНИМУМ. Рост суммы
--      нормален (человек ходит по новой карточке), уменьшение останавливает миграцию.
--      Фактические числа печатаются в предпросмотре — зафиксировать их и сверить с
--      итогом после применения.
--
-- ЗАПУСК:
--   предпросмотр (по умолчанию): изменения выполняются ВНУТРИ транзакции и
--   откатываются ROLLBACK в конце — это не read-only прогон, запускать только
--   после остановки бэкенда:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 245_merge_sigur_rebound_duplicates.sql
--   применение:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v apply=on -f 245_merge_sigur_rebound_duplicates.sql
--
-- Что делает (одна транзакция):
--   1) предохранители по каждой паре: полное ожидаемое состояние обоих профилей
--      (ФИО, оба Sigur ID, статус, дата увольнения, отдел, табельный, is_archived,
--      department_locked, отсутствие claim), пустая история employee_assignments,
--      ровно одно неотменённое событие увольнения нужной даты, отсутствие FK-ссылок
--      на дубль вне skud_events / skud_daily_summary / employee_department_access,
--      отсутствие в дубле «ценных» данных, сумма проходов не ниже минимума,
--      отсутствие у дубля проходов раньше дня смены карточки;
--   2) backup в public.migration_245_backup (шесть видов на пару);
--   3) перенос Sigur ID + отдел/должность на старый профиль, active, сброс
--      dismissal_date/claim и всех трёх exclusion-полей; пометка ошибочного события
--      cancelled = true (второе событие НЕ вставляется); перенос проходов; пересчёт
--      сводки по v_affected_dates; доступы; удаление дубля; аудит;
--   4) постусловия по каждой паре — иначе EXCEPTION и откат всей транзакции.
--
-- v_affected_dates = даты переносимых проходов ∪ (дата − 1) для каждой: расчёт смены
-- читает события следующих суток (см. 168_skud_night_shift_gate.sql), поэтому перенос
-- прохода за день D меняет и сводку за D−1. Для текущих пар это 13–17.08.
--
-- Повторный запуск: уже слитая пара распознаётся и пропускается, но только если
-- целевое состояние ПОЛНОЕ (см. ветку «уже слито ранее»).
--
-- ПОСЛЕ ПОДТВЕРЖДЕНИЯ РЕЗУЛЬТАТА: удалить backup-таблицу (в ней снимки кадровых
-- данных) — DROP TABLE public.migration_245_backup;
--
-- ОТКАТ ПОСЛЕ COMMIT: отдельный исполняемый файл
--   245_rollback_merge_sigur_rebound_duplicates.sql
-- Он восстанавливает состояние по снимкам в правильном порядке (старый профиль →
-- дубль → событие → проходы → доступы → сводка), сверяет число затронутых строк со
-- снимками и падает с EXCEPTION при любом расхождении. У него тот же режим запуска:
-- по умолчанию предпросмотр с ROLLBACK, применение — с -v apply=on.
-- ============================================================================

-- Предпросмотр по умолчанию: apply включается только явным -v apply=on.
\if :{?apply}
\else
\set apply off
\endif

BEGIN;

-- Backup-таблица (постоянная): снимки всех изменяемых данных, по записи на (пара, вид).
CREATE TABLE IF NOT EXISTS public.migration_245_backup (
  backup_at      timestamptz NOT NULL DEFAULT now(),
  migration_name text        NOT NULL DEFAULT '245',
  kind           text        NOT NULL,   -- old_employee | new_employee | dismissal_event | moved_events | access | summary
  pair_old_id    bigint      NOT NULL,
  pair_new_id    bigint      NOT NULL,
  employee_id    bigint,
  row_data       jsonb       NOT NULL,
  CONSTRAINT migration_245_backup_uniq UNIQUE (migration_name, pair_old_id, pair_new_id, kind)
);

-- В снимках лежат кадровые данные: доступ только владельцу/суперпользователю.
-- RLS включаем БЕЗ FORCE намеренно: FORCE распространяется и на владельца, из-за чего
-- повторный прогон миграции не смог бы писать собственный backup.
REVOKE ALL ON public.migration_245_backup FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON public.migration_245_backup FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON public.migration_245_backup FROM authenticated';
  END IF;
END $$;
ALTER TABLE public.migration_245_backup ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  -- Пары описаны полным ожидаемым состоянием: любое расхождение = остановка.
  c_pairs CONSTANT jsonb := '[
    {"old_id":2568,"new_id":13403,"full_name":"Шарипов Исмоилджон Нуруллоевич",
     "old_sigur_id":143276,"new_sigur_id":125698,"dismissal_date":"2026-08-14",
     "department_id":"c9c64ff6-d166-4109-b23f-4bdb1bc45bd0","keep_tab_number":"05919",
     "min_total_events":619},
    {"old_id":2550,"new_id":13404,"full_name":"Мустафаев Уктам Мустафаевич",
     "old_sigur_id":143271,"new_sigur_id":142215,"dismissal_date":"2026-08-14",
     "department_id":"76ea6b67-fdfe-46e8-aee5-9ade962c16fe","keep_tab_number":"05967",
     "min_total_events":1193}
  ]'::jsonb;

  -- Поля employees, которым РАЗРЕШЕНО отличаться у дубля: они либо переносятся,
  -- либо технические. Всё остальное непустое и отличное от старого профиля = стоп.
  c_mergeable_keys CONSTANT text[] := ARRAY[
    'id', 'sigur_employee_id', 'org_department_id', 'position_id', 'employment_status',
    'dismissal_date', 'dismissal_apply_started_at', 'excluded_from_timesheet',
    'excluded_from_timesheet_date', 'excluded_from_timesheet_at', 'tab_number',
    'hire_date', 'created_at', 'updated_at', 'is_archived', 'archived_at',
    'department_locked', 'name_locked', 'current_status'
  ];

  c_tech_sources CONSTANT text[] := ARRAY['sigur_sync', 'portal_lifecycle'];

  p               jsonb;
  v_old_id        bigint;
  v_new_id        bigint;
  v_name          text;
  v_old_sigur     bigint;
  v_new_sigur     bigint;
  v_dismissal     date;
  v_dept          uuid;
  v_tab           text;
  v_min_total     bigint;

  v_old           employees%ROWTYPE;
  v_new           employees%ROWTYPE;
  v_found_new     boolean;
  v_hire_date     date;
  v_event_id      uuid;
  v_position_id   uuid;
  v_old_events    bigint;
  v_new_events    bigint;
  v_moved         bigint;
  v_total         bigint;
  v_affected      date[];
  v_backup_dates  date[];
  v_backup_old    jsonb;
  v_backup_new    jsonb;
  v_backup_sum    jsonb;
  v_bad           text;
  v_cnt           bigint;
  v_merged        int := 0;
  r               record;
  n               bigint;
BEGIN
  FOR p IN SELECT * FROM jsonb_array_elements(c_pairs) LOOP
    v_old_id    := (p->>'old_id')::bigint;
    v_new_id    := (p->>'new_id')::bigint;
    v_name      := p->>'full_name';
    v_old_sigur := (p->>'old_sigur_id')::bigint;
    v_new_sigur := (p->>'new_sigur_id')::bigint;
    v_dismissal := (p->>'dismissal_date')::date;
    v_dept      := (p->>'department_id')::uuid;
    v_tab       := p->>'keep_tab_number';
    v_min_total := (p->>'min_total_events')::bigint;

    SELECT * INTO v_old FROM employees WHERE id = v_old_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — старый профиль не найден', v_name, v_old_id;
    END IF;

    SELECT * INTO v_new FROM employees WHERE id = v_new_id FOR UPDATE;
    v_found_new := FOUND;

    -- ─── Ветка «уже слито ранее»: принимаем только ПОЛНОЕ целевое состояние ───
    IF NOT v_found_new THEN
      v_bad := NULL;

      SELECT row_data INTO v_backup_old FROM public.migration_245_backup
       WHERE migration_name = '245' AND pair_old_id = v_old_id AND pair_new_id = v_new_id AND kind = 'old_employee';
      SELECT row_data INTO v_backup_new FROM public.migration_245_backup
       WHERE migration_name = '245' AND pair_old_id = v_old_id AND pair_new_id = v_new_id AND kind = 'new_employee';
      SELECT row_data INTO v_backup_sum FROM public.migration_245_backup
       WHERE migration_name = '245' AND pair_old_id = v_old_id AND pair_new_id = v_new_id AND kind = 'summary';

      IF v_old.employment_status IS DISTINCT FROM 'active' THEN v_bad := concat_ws('; ', v_bad, 'статус ' || coalesce(v_old.employment_status, 'null')); END IF;
      IF v_old.is_archived IS DISTINCT FROM false THEN v_bad := concat_ws('; ', v_bad, 'профиль архивный'); END IF;
      IF v_old.sigur_employee_id IS DISTINCT FROM v_new_sigur THEN v_bad := concat_ws('; ', v_bad, 'sigur ' || coalesce(v_old.sigur_employee_id::text, 'null')); END IF;
      IF v_old.org_department_id IS DISTINCT FROM v_dept THEN v_bad := concat_ws('; ', v_bad, 'отдел ' || coalesce(v_old.org_department_id::text, 'null')); END IF;
      IF v_old.tab_number IS DISTINCT FROM v_tab THEN v_bad := concat_ws('; ', v_bad, 'табельный ' || coalesce(v_old.tab_number, 'null')); END IF;
      IF v_old.dismissal_date IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'есть dismissal_date'); END IF;
      IF v_old.dismissal_apply_started_at IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'висит claim увольнения'); END IF;
      IF v_old.excluded_from_timesheet IS DISTINCT FROM false THEN v_bad := concat_ws('; ', v_bad, 'исключён из табеля'); END IF;
      IF v_old.excluded_from_timesheet_date IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'есть excluded_from_timesheet_date'); END IF;
      IF v_old.excluded_from_timesheet_at IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'есть excluded_from_timesheet_at'); END IF;

      IF v_backup_new IS NOT NULL OR v_backup_old IS NOT NULL THEN
        IF v_old.position_id IS DISTINCT FROM COALESCE((v_backup_new->>'position_id')::uuid, (v_backup_old->>'position_id')::uuid) THEN
          v_bad := concat_ws('; ', v_bad, 'position_id не равен COALESCE(дубль, старый)');
        END IF;
      END IF;

      -- Ровно одно ОТМЕНЁННОЕ событие нужной даты и ни одного неотменённого.
      SELECT count(*) INTO v_cnt FROM employee_dismissal_events
       WHERE employee_id = v_old_id AND dismissal_date = v_dismissal AND cancelled = true;
      IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, format('отменённых событий увольнения от %s: %s', v_dismissal, v_cnt)); END IF;
      SELECT count(*) INTO v_cnt FROM employee_dismissal_events
       WHERE employee_id = v_old_id AND dismissal_date = v_dismissal AND cancelled = false;
      IF v_cnt <> 0 THEN v_bad := concat_ws('; ', v_bad, 'осталось неотменённое событие увольнения'); END IF;

      SELECT count(*) INTO v_cnt FROM employee_department_access
       WHERE employee_id = v_old_id AND department_id = v_dept AND is_active = true;
      IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, 'нет активного доступа к целевому отделу'); END IF;
      SELECT count(*) INTO v_cnt FROM employee_department_access
       WHERE employee_id = v_old_id AND department_id <> v_dept AND is_active = true AND source = ANY (c_tech_sources);
      IF v_cnt <> 0 THEN v_bad := concat_ws('; ', v_bad, format('лишних активных технических доступов: %s', v_cnt)); END IF;

      SELECT count(*) INTO v_cnt FROM skud_events WHERE employee_id = v_old_id;
      IF v_cnt < v_min_total THEN v_bad := concat_ws('; ', v_bad, format('проходов %s, минимум %s', v_cnt, v_min_total)); END IF;

      SELECT count(DISTINCT kind) INTO v_cnt FROM public.migration_245_backup
       WHERE migration_name = '245' AND pair_old_id = v_old_id AND pair_new_id = v_new_id
         AND kind IN ('old_employee', 'new_employee', 'dismissal_event', 'moved_events', 'access', 'summary');
      IF v_cnt <> 6 THEN v_bad := concat_ws('; ', v_bad, format('видов backup %s из 6', v_cnt)); END IF;

      -- Строка сводки должна быть за КАЖДУЮ дату из backup'а, включая дни без входа
      -- (batch_recalculate пишет для них is_present = false).
      IF v_backup_sum IS NOT NULL THEN
        SELECT count(*) INTO v_cnt
          FROM jsonb_array_elements_text(COALESCE(v_backup_sum->'affected_dates', '[]'::jsonb)) AS t(d)
         WHERE NOT EXISTS (
           SELECT 1 FROM skud_daily_summary s WHERE s.employee_id = v_old_id AND s.date = t.d::date
         );
        IF v_cnt > 0 THEN v_bad := concat_ws('; ', v_bad, format('нет строк сводки за %s затронутых дат', v_cnt)); END IF;
      END IF;

      SELECT count(*) INTO v_cnt FROM audit_logs
       WHERE action = 'MERGE_SIGUR_REBOUND_DUPLICATE' AND entity_id = v_old_id::text;
      IF v_cnt = 0 THEN v_bad := concat_ws('; ', v_bad, 'нет записи в audit_logs'); END IF;

      FOR r IN
        SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
         WHERE c.contype = 'f' AND c.confrelid = 'public.employees'::regclass
           AND rel.relispartition = false
      LOOP
        EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO n USING v_new_id;
        IF n > 0 THEN v_bad := concat_ws('; ', v_bad, format('ссылки %s.%s=%s', r.tbl, r.col, n)); END IF;
      END LOOP;

      IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — дубль % отсутствует, но слияние неполное: %',
          v_name, v_old_id, v_new_id, v_bad;
      END IF;

      RAISE NOTICE 'МИГРАЦИЯ 245: % (%) — уже слито ранее, пропуск', v_name, v_old_id;
      CONTINUE;
    END IF;

    -- ─── Предохранители ───
    IF lower(regexp_replace(translate(v_old.full_name, 'ёЁ', 'еЕ'), '\s+', ' ', 'g'))
       IS DISTINCT FROM lower(regexp_replace(translate(v_name, 'ёЁ', 'еЕ'), '\s+', ' ', 'g')) THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — ФИО старого профиля не совпадает («%»)', v_name, v_old_id, v_old.full_name;
    END IF;
    IF lower(regexp_replace(translate(v_new.full_name, 'ёЁ', 'еЕ'), '\s+', ' ', 'g'))
       IS DISTINCT FROM lower(regexp_replace(translate(v_name, 'ёЁ', 'еЕ'), '\s+', ' ', 'g')) THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — ФИО дубля не совпадает («%»)', v_name, v_new_id, v_new.full_name;
    END IF;
    IF v_old.sigur_employee_id IS DISTINCT FROM v_old_sigur THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — sigur_employee_id = %, ожидался %', v_name, v_old_id, v_old.sigur_employee_id, v_old_sigur;
    END IF;
    IF v_old.employment_status IS DISTINCT FROM 'fired' THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — старый профиль не fired (%)', v_name, v_old_id, v_old.employment_status;
    END IF;
    IF v_old.dismissal_date IS DISTINCT FROM v_dismissal THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — dismissal_date = %, ожидалась %', v_name, v_old_id, v_old.dismissal_date, v_dismissal;
    END IF;
    IF v_old.tab_number IS DISTINCT FROM v_tab THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — tab_number = %, ожидался %', v_name, v_old_id, v_old.tab_number, v_tab;
    END IF;
    IF v_old.is_archived IS DISTINCT FROM false OR v_new.is_archived IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % — архивный профиль в паре (старый=%, дубль=%)', v_name, v_old.is_archived, v_new.is_archived;
    END IF;
    IF v_old.department_locked IS DISTINCT FROM false OR v_new.department_locked IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % — отдел закреплён вручную (department_locked), автоматическая смена запрещена', v_name;
    END IF;
    IF v_new.sigur_employee_id IS DISTINCT FROM v_new_sigur THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — sigur_employee_id дубля = %, ожидался %', v_name, v_new_id, v_new.sigur_employee_id, v_new_sigur;
    END IF;
    IF v_new.employment_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — дубль не active (%)', v_name, v_new_id, v_new.employment_status;
    END IF;
    IF v_new.org_department_id IS DISTINCT FROM v_dept THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — отдел дубля = %, ожидался %', v_name, v_new_id, v_new.org_department_id, v_dept;
    END IF;
    IF v_new.dismissal_apply_started_at IS NOT NULL OR v_old.dismissal_apply_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % — висит claim увольнения (старый=%, дубль=%)', v_name, v_old.dismissal_apply_started_at, v_new.dismissal_apply_started_at;
    END IF;

    -- В дубле не должно быть ценных данных, кроме переносимых: иначе они пропадут при удалении.
    SELECT string_agg(format('%s: дубль=%s, старый=%s', d.key, d.new_val, d.old_val), '; ')
      INTO v_bad
      FROM (
        SELECT k.key, to_jsonb(v_new) -> k.key AS new_val, to_jsonb(v_old) -> k.key AS old_val
          FROM jsonb_object_keys(to_jsonb(v_new)) AS k(key)
      ) d
     WHERE NOT (d.key = ANY (c_mergeable_keys))
       AND d.new_val IS DISTINCT FROM 'null'::jsonb
       AND d.new_val IS DISTINCT FROM d.old_val;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — в дубле есть данные, которых нет в основном профиле: %', v_name, v_new_id, v_bad;
    END IF;

    -- История отделов: правку периодов миграция не делает, членство идёт по snapshot.
    SELECT count(*) INTO v_cnt FROM employee_assignments WHERE employee_id IN (v_old_id, v_new_id);
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — найдено % строк employee_assignments, нужно ручное решение', v_name, v_old_id, v_cnt;
    END IF;

    SELECT count(*) INTO v_cnt FROM employee_dismissal_events
     WHERE employee_id = v_old_id AND dismissal_date = v_dismissal AND cancelled = false;
    IF v_cnt <> 1 THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — неотменённых событий увольнения от %: % (ожидалось 1)', v_name, v_old_id, v_dismissal, v_cnt;
    END IF;
    SELECT id INTO v_event_id FROM employee_dismissal_events
     WHERE employee_id = v_old_id AND dismissal_date = v_dismissal AND cancelled = false;

    -- Ссылки на дубль вне обрабатываемого списка (партиции пропускаем: дублируют родителя).
    v_bad := NULL;
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'public.employees'::regclass
         AND rel.relispartition = false
         AND split_part(c.conrelid::regclass::text, '.', -1)
             NOT IN ('skud_events', 'skud_daily_summary', 'employee_department_access')
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO n USING v_new_id;
      IF n > 0 THEN v_bad := concat_ws(', ', v_bad, format('%s.%s=%s', r.tbl, r.col, n)); END IF;
    END LOOP;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — ссылки на дубль вне обрабатываемого списка: %', v_name, v_new_id, v_bad;
    END IF;

    SELECT count(*) INTO v_old_events FROM skud_events WHERE employee_id = v_old_id;
    SELECT count(*) INTO v_new_events FROM skud_events WHERE employee_id = v_new_id;
    -- Контроль устойчив ко времени: новые проходы по новой карточке — норма (сумма растёт),
    -- а вот УМЕНЬШЕНИЕ относительно снятого минимума означает, что проходы куда-то делись.
    IF v_old_events + v_new_events < v_min_total THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — проходов % + % = %, минимум %: часть проходов пропала, разобраться до слияния',
        v_name, v_old_id, v_old_events, v_new_events, v_old_events + v_new_events, v_min_total;
    END IF;

    -- Все проходы дубля обязаны лежать не раньше дня смены карточки: иначе это не
    -- «новый профиль от смены карточки», а что-то другое.
    SELECT count(*) INTO v_cnt FROM skud_events WHERE employee_id = v_new_id AND event_date < v_dismissal;
    IF v_cnt > 0 THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — у дубля % проходов раньше %, слияние небезопасно', v_name, v_new_id, v_cnt, v_dismissal;
    END IF;

    -- Затронутые даты сводки: дни переносимых проходов и предыдущий день каждого
    -- (расчёт смены читает события следующих суток — миграция 168).
    SELECT array_agg(DISTINCT d ORDER BY d) INTO v_affected
      FROM (
        SELECT event_date AS d FROM skud_events WHERE employee_id = v_new_id
        UNION
        SELECT event_date - 1 FROM skud_events WHERE employee_id = v_new_id
      ) x;

    -- Backup сводки берём на день шире: batch_recalculate пересчитывает ещё и (date − 1)
    -- каждой переданной даты, поэтому строка за день перед набором тоже перезаписывается.
    SELECT array_agg(DISTINCT d ORDER BY d) INTO v_backup_dates
      FROM (
        SELECT unnest(COALESCE(v_affected, ARRAY[]::date[])) AS d
        UNION
        SELECT unnest(COALESCE(v_affected, ARRAY[]::date[])) - 1
      ) x;

    RAISE NOTICE 'МИГРАЦИЯ 245: % (% ← %) — проходов % + % = %, пересчёт сводки за %',
      v_name, v_old_id, v_new_id, v_old_events, v_new_events, v_old_events + v_new_events, v_affected;

    -- ─── Backup всех изменяемых данных (по записи на вид, даже если массив пуст) ───
    v_hire_date := v_old.hire_date;

    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    VALUES ('old_employee', v_old_id, v_new_id, v_old_id, jsonb_build_object(
              'sigur_employee_id', v_old.sigur_employee_id,
              'org_department_id', v_old.org_department_id,
              'position_id', v_old.position_id,
              'employment_status', v_old.employment_status,
              'dismissal_date', v_old.dismissal_date,
              'dismissal_apply_started_at', v_old.dismissal_apply_started_at,
              'excluded_from_timesheet', v_old.excluded_from_timesheet,
              'excluded_from_timesheet_date', v_old.excluded_from_timesheet_date,
              'excluded_from_timesheet_at', v_old.excluded_from_timesheet_at,
              'updated_at', v_old.updated_at))
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    VALUES ('new_employee', v_old_id, v_new_id, v_new_id, to_jsonb(v_new))
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    SELECT 'dismissal_event', v_old_id, v_new_id, v_old_id, to_jsonb(d)
      FROM employee_dismissal_events d WHERE d.id = v_event_id
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    SELECT 'moved_events', v_old_id, v_new_id, v_new_id,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'event_date', s.event_date))
                       FROM skud_events s WHERE s.employee_id = v_new_id), '[]'::jsonb)
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    SELECT 'access', v_old_id, v_new_id, NULL,
           COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM employee_department_access a
                      WHERE a.employee_id IN (v_old_id, v_new_id)), '[]'::jsonb)
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    -- Сводка: у основного профиля — затронутые даты плюс день перед ними (побочный
    -- пересчёт), у дубля — все строки.
    INSERT INTO public.migration_245_backup (kind, pair_old_id, pair_new_id, employee_id, row_data)
    SELECT 'summary', v_old_id, v_new_id, NULL, jsonb_build_object(
             'affected_dates', COALESCE(to_jsonb(v_affected), '[]'::jsonb),
             'backup_dates', COALESCE(to_jsonb(v_backup_dates), '[]'::jsonb),
             'old', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM skud_daily_summary s
                               WHERE s.employee_id = v_old_id
                                 AND s.date = ANY (COALESCE(v_backup_dates, ARRAY[]::date[]))), '[]'::jsonb),
             'new', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM skud_daily_summary s
                               WHERE s.employee_id = v_new_id), '[]'::jsonb))
    ON CONFLICT ON CONSTRAINT migration_245_backup_uniq
    DO UPDATE SET row_data = EXCLUDED.row_data, backup_at = now();

    -- ─── Правки ───
    v_position_id := COALESCE(v_new.position_id, v_old.position_id);

    -- Sigur ID уникален (idx_employees_sigur_id, partial по is_archived = false) —
    -- сначала снимаем его с дубля.
    UPDATE employees SET sigur_employee_id = NULL, updated_at = now() WHERE id = v_new_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'МИГРАЦИЯ 245: % — снятие sigur_employee_id с дубля затронуло % строк', v_name, v_cnt; END IF;

    -- Кадровые данные, табельный номер и hire_date остаются от старого профиля.
    UPDATE employees
       SET sigur_employee_id = v_new_sigur,
           org_department_id = v_dept,
           position_id = v_position_id,
           employment_status = 'active',
           dismissal_date = NULL,
           dismissal_apply_started_at = NULL,
           excluded_from_timesheet = false,
           excluded_from_timesheet_date = NULL,
           excluded_from_timesheet_at = NULL,
           updated_at = now()
     WHERE id = v_old_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'МИГРАЦИЯ 245: % — обновление основного профиля затронуло % строк', v_name, v_cnt; END IF;

    -- Ошибочное увольнение помечаем отменённым в самой строке: второе событие не
    -- вставляем, иначе в истории окажутся две отмены.
    UPDATE employee_dismissal_events
       SET cancelled = true,
           reason = COALESCE(reason, 'Смена карточки Sigur — увольнение ошибочно')
     WHERE id = v_event_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'МИГРАЦИЯ 245: % — отмена увольнения затронула % строк', v_name, v_cnt; END IF;

    UPDATE skud_events SET employee_id = v_old_id WHERE employee_id = v_new_id;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved <> v_new_events THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % — перенесено % проходов, ожидалось %', v_name, v_moved, v_new_events;
    END IF;

    -- Сводка: у основного профиля сносим только затронутые даты (дни без проходов за
    -- пределами набора трогать нельзя), у дубля — все строки, он удаляется целиком.
    DELETE FROM skud_daily_summary
     WHERE employee_id = v_old_id AND date = ANY (COALESCE(v_affected, ARRAY[]::date[]));
    DELETE FROM skud_daily_summary WHERE employee_id = v_new_id;

    IF v_affected IS NOT NULL THEN
      PERFORM public.batch_recalculate_skud_daily_summary(
        (SELECT jsonb_agg(jsonb_build_object('emp_id', v_old_id, 'date', d)) FROM unnest(v_affected) AS d)
      );
    END IF;

    -- Доступы зеркалят backend-гард: целевой отдел активен, прочие ТЕХНИЧЕСКИЕ доступы
    -- гасим (ручные manual_admin_ui не трогаем).
    UPDATE employee_department_access
       SET is_active = false, updated_at = now()
     WHERE employee_id = v_old_id
       AND department_id <> v_dept
       AND source = ANY (c_tech_sources)
       AND is_active = true;

    INSERT INTO employee_department_access (employee_id, department_id, source, is_active, created_at, updated_at)
    VALUES (v_old_id, v_dept, 'sigur_sync', true, now(), now())
    ON CONFLICT (employee_id, department_id)
    DO UPDATE SET is_active = true, updated_at = EXCLUDED.updated_at;

    -- Дубль удаляем: его employee_department_access уходит каскадом. Оставлять его
    -- активным «портальным» нельзя — синк привяжет к нему первую же карточку по ФИО.
    DELETE FROM employees WHERE id = v_new_id;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt <> 1 THEN RAISE EXCEPTION 'МИГРАЦИЯ 245: % — удаление дубля затронуло % строк', v_name, v_cnt; END IF;

    INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
    VALUES (NULL, 'MERGE_SIGUR_REBOUND_DUPLICATE', 'employee', v_old_id::text,
            jsonb_build_object(
              'employee_id', v_old_id,
              'deleted_employee_id', v_new_id,
              'name', v_name,
              'old_sigur_id', v_old_sigur,
              'new_sigur_id', v_new_sigur,
              'department_id', v_dept,
              'cancelled_dismissal_event_id', v_event_id,
              'moved_events', v_moved,
              'affected_dates', to_jsonb(v_affected),
              'migration', '245'
            ));

    -- ─── Постусловия ───
    SELECT * INTO v_old FROM employees WHERE id = v_old_id;
    v_bad := NULL;
    IF v_old.employment_status IS DISTINCT FROM 'active' THEN v_bad := concat_ws('; ', v_bad, 'статус ' || coalesce(v_old.employment_status, 'null')); END IF;
    IF v_old.is_archived IS DISTINCT FROM false THEN v_bad := concat_ws('; ', v_bad, 'профиль архивный'); END IF;
    IF v_old.sigur_employee_id IS DISTINCT FROM v_new_sigur THEN v_bad := concat_ws('; ', v_bad, 'sigur ' || coalesce(v_old.sigur_employee_id::text, 'null')); END IF;
    IF v_old.org_department_id IS DISTINCT FROM v_dept THEN v_bad := concat_ws('; ', v_bad, 'отдел ' || coalesce(v_old.org_department_id::text, 'null')); END IF;
    IF v_old.position_id IS DISTINCT FROM v_position_id THEN v_bad := concat_ws('; ', v_bad, 'position_id не равен COALESCE(дубль, старый)'); END IF;
    IF v_old.tab_number IS DISTINCT FROM v_tab THEN v_bad := concat_ws('; ', v_bad, 'табельный ' || coalesce(v_old.tab_number, 'null')); END IF;
    IF v_old.hire_date IS DISTINCT FROM v_hire_date THEN v_bad := concat_ws('; ', v_bad, 'изменилась hire_date'); END IF;
    IF v_old.dismissal_date IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'остался dismissal_date'); END IF;
    IF v_old.dismissal_apply_started_at IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'остался claim увольнения'); END IF;
    IF v_old.excluded_from_timesheet IS DISTINCT FROM false THEN v_bad := concat_ws('; ', v_bad, 'исключён из табеля'); END IF;
    IF v_old.excluded_from_timesheet_date IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'остался excluded_from_timesheet_date'); END IF;
    IF v_old.excluded_from_timesheet_at IS NOT NULL THEN v_bad := concat_ws('; ', v_bad, 'остался excluded_from_timesheet_at'); END IF;

    SELECT count(*) INTO v_cnt FROM employee_dismissal_events WHERE id = v_event_id AND cancelled = true;
    IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, 'ошибочное увольнение не отменено'); END IF;

    SELECT count(*) INTO v_cnt FROM employee_department_access
     WHERE employee_id = v_old_id AND department_id = v_dept AND is_active = true;
    IF v_cnt <> 1 THEN v_bad := concat_ws('; ', v_bad, 'нет активного доступа к целевому отделу'); END IF;
    SELECT count(*) INTO v_cnt FROM employee_department_access
     WHERE employee_id = v_old_id AND department_id <> v_dept AND is_active = true AND source = ANY (c_tech_sources);
    IF v_cnt <> 0 THEN v_bad := concat_ws('; ', v_bad, format('лишних активных технических доступов: %s', v_cnt)); END IF;

    SELECT count(*) INTO v_total FROM skud_events WHERE employee_id = v_old_id;
    IF v_total <> v_old_events + v_new_events THEN
      v_bad := concat_ws('; ', v_bad, format('проходов %s, ожидалось %s (%s + %s)', v_total, v_old_events + v_new_events, v_old_events, v_new_events));
    END IF;
    IF v_total < v_min_total THEN v_bad := concat_ws('; ', v_bad, format('проходов %s меньше минимума %s', v_total, v_min_total)); END IF;

    SELECT count(*) INTO v_cnt FROM employees WHERE id = v_new_id;
    IF v_cnt <> 0 THEN v_bad := concat_ws('; ', v_bad, 'дубль не удалён'); END IF;

    -- Ссылок на удалённый профиль не осталось нигде.
    FOR r IN
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_class rel ON rel.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'public.employees'::regclass
         AND rel.relispartition = false
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO n USING v_new_id;
      IF n > 0 THEN v_bad := concat_ws('; ', v_bad, format('остались ссылки %s.%s=%s', r.tbl, r.col, n)); END IF;
    END LOOP;

    -- Сводка пересчитана: строка обязана быть за КАЖДУЮ затронутую дату, в том числе
    -- за дни без входа — batch_recalculate пишет для них пустую строку is_present = false
    -- (см. 168_skud_night_shift_gate.sql). Условие «где есть проходы» пропустило бы
    -- потерю строк за 13 и 16 августа.
    SELECT count(*) INTO v_cnt
      FROM unnest(COALESCE(v_affected, ARRAY[]::date[])) AS d
     WHERE NOT EXISTS (SELECT 1 FROM skud_daily_summary s WHERE s.employee_id = v_old_id AND s.date = d);
    IF v_cnt > 0 THEN v_bad := concat_ws('; ', v_bad, format('нет строк сводки за %s из %s затронутых дат', v_cnt, array_length(v_affected, 1))); END IF;

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'МИГРАЦИЯ 245: % (%) — постусловия не выполнены: %', v_name, v_old_id, v_bad;
    END IF;

    v_merged := v_merged + 1;
    RAISE NOTICE 'МИГРАЦИЯ 245: % (%) — готово: sigur %, перенесено проходов %, всего %',
      v_name, v_old_id, v_new_sigur, v_moved, v_total;
  END LOOP;

  RAISE NOTICE 'МИГРАЦИЯ 245: слито пар — %', v_merged;
END $$;

-- Диагностика ВНУТРИ транзакции (до COMMIT/ROLLBACK): в предпросмотре показывает
-- предполагаемый результат, при apply — фактический.
SELECT e.id, e.full_name, e.tab_number, e.sigur_employee_id, e.employment_status,
       e.is_archived, e.dismissal_date, e.hire_date, e.org_department_id,
       (SELECT count(*) FROM skud_events s WHERE s.employee_id = e.id) AS events,
       (SELECT count(*) FROM employee_department_access a
         WHERE a.employee_id = e.id AND a.is_active) AS active_access
FROM employees e
WHERE e.id IN (2568, 2550)
ORDER BY e.id;

SELECT count(*) AS duplicates_left FROM employees WHERE id IN (13403, 13404);

SELECT employee_id, date, is_present, total_minutes
FROM skud_daily_summary
WHERE employee_id IN (2568, 2550) AND date >= DATE '2026-08-13'
ORDER BY employee_id, date;

\if :apply
COMMIT;
\else
ROLLBACK;
\endif
