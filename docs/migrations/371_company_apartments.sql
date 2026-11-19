-- 371: «Управление кадрами» → «Проживание» → вкладка «Квартира»: служебные квартиры компании (как «Учёт квартир» 1С).
--
-- Зачем (решения пользователя 19.11.2026). Вкладка «Проживание» делится на «Квартира» (служебные квартиры компании),
-- «Общежитие» и «Компенсация аренды». Служебные квартиры до сих пор заводились как общежитие с адресом «Кв. …»
-- (8 записей проживания, 6 квартир — пользователь сверил с 1С). Теперь у квартиры своя строка: адрес, пометка,
-- комнат, мест, цена аренды, «оплачено по»; жилец квартиры — то же проживание вида «общежитие» со ссылкой на неё.
--
-- Классы записей employee_dormitory_stays (одинаково во всех API, таблицах и выгрузках):
--   служебная квартира — kind = 'dormitory' AND apartment_id IS NOT NULL;
--   общежитие          — kind = 'dormitory' AND apartment_id IS NULL;
--   компенсация аренды — kind = 'apartment' (630 ₽/день «Зарплаты»; apartment_id всегда NULL).
-- Вид жильца квартиры остаётся 'dormitory', поэтому расчёт «Зарплаты» не меняется ни строкой: дни любого проживания
-- снимают авто-доплату за общежитие (как и сейчас у «Кв. …»), компенсация 630 ₽ начисляется только виду 'apartment'.
--
-- Адрес квартиры — источник company_apartments.address. В проживании хранится копия «Кв. <адрес>» (её читает
-- «Справочник → Общежитие» «Зарплаты»); правка адреса квартиры переписывает копии в той же транзакции (бэкенд).
-- Общежитие с адресом на «Кв.» без ссылки на квартиру запрещено CHECK-ом — псевдоквартиру не завести.
--
-- paid — галочка «Платно» (только у служебной квартиры, CHECK); comment — комментарий (столбец «Комментарий»
-- «Компенсации аренды»). Колонок-авторов нет: кто правил — в audit_logs (FK на пользователя не появляется).
--
-- Деньги: 0 изменений — у 8 записей меняются только apartment_id (вид, даты и адрес те же).
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА, одним окном с ним (deploy-server.sh migrate, сразу backend): старый бэкенд новые колонки
-- не читает и не ломается, но мог бы поменять адрес жильца квартиры мимо квартиры. Повторный запуск безопасен.
-- Номер 371: 370 — 370_employee_supervisor_ktu_access.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS company_apartments (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address     TEXT NOT NULL,
  note        TEXT,
  rooms       SMALLINT,
  places      SMALLINT,
  price       NUMERIC(12,2),
  paid_until  DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_apartment_address CHECK (btrim(address) <> '' AND length(address) <= 200),
  CONSTRAINT company_apartment_note CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 100)),
  CONSTRAINT company_apartment_rooms CHECK (rooms IS NULL OR rooms > 0),
  CONSTRAINT company_apartment_places CHECK (places IS NULL OR places > 0),
  CONSTRAINT company_apartment_price CHECK (price IS NULL OR price > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS company_apartments_address_key ON company_apartments (lower(btrim(address)));

COMMENT ON TABLE company_apartments IS
  'Служебные квартиры компании — «Управление кадрами» → «Проживание» → «Квартира» (миграция 371). Жильцы — '
  'employee_dormitory_stays с apartment_id (вид dormitory).';
COMMENT ON COLUMN company_apartments.address IS 'Адрес без «Кв.»; в проживании хранится копия «Кв. <адрес>».';
COMMENT ON COLUMN company_apartments.note IS 'Пометка из 1С: «РФ \ ВНЖ», «семейная».';
COMMENT ON COLUMN company_apartments.places IS 'Мест — справочно, не лимит заселения.';
COMMENT ON COLUMN company_apartments.price IS 'Аренда ₽/мес.';
COMMENT ON COLUMN company_apartments.paid_until IS '«Оплачено по» — дата, по которую оплачена аренда.';

ALTER TABLE employee_dormitory_stays
  ADD COLUMN IF NOT EXISTS apartment_id INTEGER REFERENCES company_apartments(id) ON DELETE RESTRICT;
ALTER TABLE employee_dormitory_stays ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE employee_dormitory_stays ADD COLUMN IF NOT EXISTS comment TEXT;

CREATE INDEX IF NOT EXISTS employee_dormitory_stays_apartment
  ON employee_dormitory_stays (apartment_id) WHERE apartment_id IS NOT NULL;

COMMENT ON COLUMN employee_dormitory_stays.apartment_id IS
  'Служебная квартира (миграция 371); только у вида dormitory. NULL — общежитие или компенсация аренды.';
COMMENT ON COLUMN employee_dormitory_stays.paid IS '«Платно» — только у жильца служебной квартиры (миграция 371).';
COMMENT ON COLUMN employee_dormitory_stays.comment IS 'Комментарий (миграция 371), до 500 символов.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_apartment_kind') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_apartment_kind
      CHECK (apartment_id IS NULL OR kind = 'dormitory');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_paid') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_paid
      CHECK (NOT paid OR apartment_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_comment') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_comment
      CHECK (comment IS NULL OR (btrim(comment) <> '' AND length(comment) <= 500));
  END IF;
END $$;

-- Квартиры из записей «Кв. …» (без префикса «Кв.»). На чистой базе таких записей нет — ничего не создаётся.
INSERT INTO company_apartments (address)
SELECT DISTINCT btrim(regexp_replace(s.address, '^\s*[Кк][Вв]\.?\s*', ''))
  FROM employee_dormitory_stays s
 WHERE s.kind = 'dormitory'
   AND s.apartment_id IS NULL
   AND s.address ~ '^\s*[Кк][Вв][.\s]'
ON CONFLICT DO NOTHING;

-- Атрибуты со скриншота 1С «Учёт квартир» (19.11.2026). Только у нетронутых квартир: повтор не затирает правки кадров.
UPDATE company_apartments a
   SET note = v.note, rooms = v.rooms, places = v.places, price = v.price, paid_until = v.paid_until, updated_at = now()
  FROM (VALUES
    ('3-й Митинский пер. 5-201', 'РФ \ ВНЖ', 2, 3, 65000.00, DATE '2026-11-01'),
    ('Васильцовский Стан 9-152', 'семейная', 1, 1, 65000.00, DATE '2026-11-03'),
    ('Ляпидевского 12-58', 'семейная РФ', 2, 3, 70000.00, DATE '2026-12-25'),
    ('Мичуринский 31-4-7', 'Узб', 2, 1, 65000.00, DATE '2026-11-18'),
    ('Новодмитровская 2-6-483', 'РФ', 1, 1, 125000.00, DATE '2026-11-11'),
    ('Складочная 6-2-27', NULL, 1, 1, 75000.00, DATE '2026-11-24')
  ) AS v(address, note, rooms, places, price, paid_until)
 WHERE lower(btrim(a.address)) = lower(v.address)
   AND a.note IS NULL AND a.rooms IS NULL AND a.places IS NULL AND a.price IS NULL AND a.paid_until IS NULL;

-- Жильцы: ссылка на квартиру, адрес — ровно «Кв. <адрес квартиры>» (копия для «Зарплаты»).
UPDATE employee_dormitory_stays s
   SET apartment_id = a.id, address = 'Кв. ' || a.address
  FROM company_apartments a
 WHERE s.kind = 'dormitory'
   AND s.apartment_id IS NULL
   AND s.address ~ '^\s*[Кк][Вв][.\s]'
   AND lower(btrim(regexp_replace(s.address, '^\s*[Кк][Вв]\.?\s*', ''))) = lower(btrim(a.address));

-- «Кв. …» больше не подсказываются как адрес общежития.
DELETE FROM dormitory_addresses WHERE address ~ '^\s*[Кк][Вв][.\s]';

-- Псевдоквартира запрещена: общежитие с адресом на «Кв.» — только со ссылкой на квартиру.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_dormitory_stay_no_pseudo_apartment') THEN
    ALTER TABLE employee_dormitory_stays ADD CONSTRAINT employee_dormitory_stay_no_pseudo_apartment
      CHECK (kind <> 'dormitory' OR apartment_id IS NOT NULL OR address !~ '^\s*[Кк][Вв][.\s]');
  END IF;
END $$;

-- Проверка: у всех жильцов квартир адрес = копия адреса квартиры.
DO $$
DECLARE
  mismatched INTEGER;
BEGIN
  SELECT count(*) INTO mismatched
    FROM employee_dormitory_stays s
    JOIN company_apartments a ON a.id = s.apartment_id
   WHERE s.address IS DISTINCT FROM 'Кв. ' || a.address;
  IF mismatched > 0 THEN
    RAISE EXCEPTION '371: у % жильцов квартир адрес не совпадает с квартирой', mismatched;
  END IF;
END $$;

COMMIT;
