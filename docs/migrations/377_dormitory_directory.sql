-- 377: «Проживание» → «Общежитие» → «Справочник»: справочник общежитий (Дата, Номер, Общежитие, Стоимость места).
--
-- Зачем (решения пользователя 23.11.2026). Общежитие было только текстом поля «Адрес / номер», подсказки — 9 адресов
-- в коде и адреса, запомненные при заселении (dormitory_addresses, миграция 319). Дату, номер и стоимость места из 1С
-- ввести было некуда, опечатка заводила «новое» общежитие. Теперь dormitory_addresses — справочник общежитий: кадры
-- ведут его в окне «Справочник» вкладки «Общежитие», а при заселении и переселении общежитие выбирают из него (сервер
-- принимает только название из справочника и сам больше ничего туда не дописывает).
--
-- Колонки (как в 1С «Общежития»): doc_date — «Дата», doc_number — «Номер» (не уникален: в 1С у «Базы Мытищи» и
-- «Верхнелихоборской 6» оба 000000004), place_price — «Стоимость места», ₽, только для информации: в расчётах
-- «Зарплаты» не участвует. Ключ — название (address, уникально без учёта регистра — индекс 319); у записей проживания
-- хранится то же название, переименование в справочнике переписывает их в той же транзакции (бэкенд).
--
-- Заполнение — по таблице 1С пользователя (8 общежитий; это ровно те 8 названий, что есть у записей на 23.11.2026).
-- Названия записей общежития, которых нет в справочнике, тоже добавляются — у каждой записи будет общежитие
-- справочника (на проде таких 0). Колонок-авторов нет: кто правил — в audit_logs.
--
-- Деньги: 0 изменений. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (deploy-server.sh migrate, затем backend): прежний бэкенд новые
-- колонки не читает и не ломается. Повторный запуск безопасен (значения 1С перезапишутся теми же).
-- Номер 377: 376 — 376_work_schedule_files.sql.

BEGIN;

ALTER TABLE dormitory_addresses ADD COLUMN IF NOT EXISTS doc_date DATE;
ALTER TABLE dormitory_addresses ADD COLUMN IF NOT EXISTS doc_number TEXT;
ALTER TABLE dormitory_addresses ADD COLUMN IF NOT EXISTS place_price NUMERIC(12,2);
ALTER TABLE dormitory_addresses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dormitory_address_doc_number') THEN
    ALTER TABLE dormitory_addresses ADD CONSTRAINT dormitory_address_doc_number
      CHECK (doc_number IS NULL OR (btrim(doc_number) <> '' AND length(doc_number) <= 30));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dormitory_address_place_price') THEN
    ALTER TABLE dormitory_addresses ADD CONSTRAINT dormitory_address_place_price
      CHECK (place_price IS NULL OR place_price > 0);
  END IF;
END $$;

COMMENT ON TABLE dormitory_addresses IS
  'Справочник общежитий («Управление кадрами» → «Проживание» → «Общежитие» → «Справочник», миграции 319 и 377): '
  'при заселении и переселении общежитие выбирают из него; название — ключ, у записей проживания то же название.';
COMMENT ON COLUMN dormitory_addresses.address IS 'Общежитие (название / адрес), уникально без учёта регистра.';
COMMENT ON COLUMN dormitory_addresses.doc_date IS '«Дата» — как в 1С (миграция 377).';
COMMENT ON COLUMN dormitory_addresses.doc_number IS '«Номер» — как в 1С, не уникален (миграция 377).';
COMMENT ON COLUMN dormitory_addresses.place_price IS
  '«Стоимость места», ₽ — только для информации, в расчётах «Зарплаты» не участвует (миграция 377).';

-- Таблица 1С: название → дата, номер, стоимость места. Временная таблица: вставка недостающих и простановка
-- значений — разными запросами (строки, вставленные в CTE, тому же запросу не видны).
CREATE TEMP TABLE onec_dormitories (address TEXT, doc_date DATE, doc_number TEXT, place_price NUMERIC(12,2)) ON COMMIT DROP;
INSERT INTO onec_dormitories (address, doc_date, doc_number, place_price) VALUES
  ('Общ. База Мытищи', DATE '2019-03-15', '000000004', NULL),
  ('Общ. База Химки', DATE '2023-03-01', '000000017', NULL),
  ('Общ. Боровское ш. 12А', DATE '2025-06-10', '000000006', 500.00),
  ('Общ. Верхнелихоборская 6', DATE '2026-04-01', '000000004', 450.00),
  ('Общ. г.Химки, ул.Рабочая д.2а', DATE '2026-05-20', '000000010', 500.00),
  ('Общ. Мал.Почтовая 2\2', DATE '2026-03-04', '000000002', 600.00),
  ('Общ. Нагатинская 34', DATE '2026-03-04', '000000003', 600.00),
  ('Общ. Свободы 35', DATE '2025-09-22', '000000009', 550.00);

INSERT INTO dormitory_addresses (address)
SELECT o.address FROM onec_dormitories o
 WHERE NOT EXISTS (SELECT 1 FROM dormitory_addresses d WHERE lower(btrim(d.address)) = lower(btrim(o.address)));

UPDATE dormitory_addresses d
   SET doc_date = o.doc_date, doc_number = o.doc_number, place_price = o.place_price, updated_at = now()
  FROM onec_dormitories o
 WHERE lower(btrim(d.address)) = lower(btrim(o.address));

-- Названия записей общежития (без служебных квартир), которых нет в справочнике: написание самой ранней записи.
INSERT INTO dormitory_addresses (address)
SELECT DISTINCT ON (lower(btrim(s.address))) btrim(s.address)
  FROM employee_dormitory_stays s
 WHERE s.kind = 'dormitory' AND s.apartment_id IS NULL AND NULLIF(btrim(s.address), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM dormitory_addresses d WHERE lower(btrim(d.address)) = lower(btrim(s.address)))
 ORDER BY lower(btrim(s.address)), s.check_in, s.id;

COMMIT;
