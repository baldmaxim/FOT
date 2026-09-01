-- 258_hr_citizenships.sql
-- Справочник гражданств для кадровых профилей («Реквизиты», перенос из PassDesk).
--
-- Зачем отдельная таблица: в FOT гражданство хранится свободным текстом
-- (employees.country) и набор «патентных» стран захардкожен в 4 местах. Для
-- кадрового модуля нужен единый предикат «нужен ли патент» с данными, а не
-- кодом: requires_patent / is_eaeu (как в PassDesk citizenships). ВНЖ снимает
-- требование патента на уровне профиля (employee_hr_profiles.has_residence_permit).
--
-- Синонимы нужны для нормализации значений из OCR («ТОЧИКИСТОН/TAJIKISTAN»),
-- Excel-импортов и переноса из PassDesk.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hr_citizenships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  iso_code varchar(3),
  requires_patent boolean NOT NULL DEFAULT true,
  is_eaeu boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hr_citizenships IS
  'Справочник гражданств кадровых профилей. requires_patent/is_eaeu задают предикат «нужен ли патент» (ВНЖ снимает его на уровне профиля).';

CREATE TABLE IF NOT EXISTS public.hr_citizenship_synonyms (
  synonym text PRIMARY KEY,
  citizenship_id uuid NOT NULL REFERENCES public.hr_citizenships(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.hr_citizenship_synonyms IS
  'Синонимы названий/кодов гражданств (lower-case) для нормализации OCR/импорта.';

CREATE INDEX IF NOT EXISTS hr_citizenship_synonyms_cit_idx
  ON public.hr_citizenship_synonyms(citizenship_id);

-- Seed (перенос из PassDesk citizenships + ISO-коды). Порядок: РФ → ЕАЭС → патентные → прочие.
INSERT INTO public.hr_citizenships (name, iso_code, requires_patent, is_eaeu, sort_order) VALUES
  ('Россия',        'RUS', false, false, 10),
  ('Беларусь',      'BLR', false, true,  20),
  ('Казахстан',     'KAZ', false, true,  21),
  ('Армения',       'ARM', false, true,  22),
  ('Кыргызстан',    'KGZ', false, true,  23),
  ('Узбекистан',    'UZB', true,  false, 30),
  ('Таджикистан',   'TJK', true,  false, 31),
  ('Украина',       'UKR', true,  false, 32),
  ('Азербайджан',   'AZE', true,  false, 33),
  ('Молдова',       'MDA', true,  false, 34),
  ('Туркменистан',  'TKM', true,  false, 35),
  ('Турция',        'TUR', true,  false, 50),
  ('Сербия',        'SRB', true,  false, 51),
  ('Иран',          'IRN', true,  false, 52),
  ('Гвинея-Бисау',  'GNB', true,  false, 53),
  ('Намибия',       'NAM', true,  false, 54),
  ('Другое',        NULL,  false, false, 900)
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.hr_citizenship_synonyms (synonym, citizenship_id)
SELECT s.synonym, c.id
FROM (VALUES
  ('россия', 'Россия'), ('российская федерация', 'Россия'), ('рф', 'Россия'), ('russia', 'Россия'),
  ('russian federation', 'Россия'), ('rus', 'Россия'), ('ru', 'Россия'), ('643', 'Россия'),
  ('беларусь', 'Беларусь'), ('белоруссия', 'Беларусь'), ('республика беларусь', 'Беларусь'),
  ('belarus', 'Беларусь'), ('blr', 'Беларусь'), ('by', 'Беларусь'), ('112', 'Беларусь'),
  ('казахстан', 'Казахстан'), ('kazakhstan', 'Казахстан'), ('kaz', 'Казахстан'), ('kz', 'Казахстан'), ('398', 'Казахстан'),
  ('армения', 'Армения'), ('armenia', 'Армения'), ('arm', 'Армения'), ('am', 'Армения'), ('051', 'Армения'),
  ('кыргызстан', 'Кыргызстан'), ('киргизия', 'Кыргызстан'), ('кыргызская республика', 'Кыргызстан'),
  ('kyrgyzstan', 'Кыргызстан'), ('kgz', 'Кыргызстан'), ('kg', 'Кыргызстан'), ('417', 'Кыргызстан'),
  ('узбекистан', 'Узбекистан'), ('узбекистон', 'Узбекистан'), ('республика узбекистан', 'Узбекистан'),
  ('uzbekistan', 'Узбекистан'), ('uzb', 'Узбекистан'), ('uz', 'Узбекистан'), ('860', 'Узбекистан'),
  ('таджикистан', 'Таджикистан'), ('точикистон', 'Таджикистан'), ('республика таджикистан', 'Таджикистан'),
  ('tajikistan', 'Таджикистан'), ('tjk', 'Таджикистан'), ('tj', 'Таджикистан'), ('762', 'Таджикистан'),
  ('украина', 'Украина'), ('ukraine', 'Украина'), ('ukr', 'Украина'), ('ua', 'Украина'), ('804', 'Украина'),
  ('азербайджан', 'Азербайджан'), ('azerbaijan', 'Азербайджан'), ('aze', 'Азербайджан'), ('az', 'Азербайджан'), ('031', 'Азербайджан'),
  ('молдова', 'Молдова'), ('молдавия', 'Молдова'), ('республика молдова', 'Молдова'),
  ('moldova', 'Молдова'), ('mda', 'Молдова'), ('md', 'Молдова'), ('498', 'Молдова'),
  ('туркменистан', 'Туркменистан'), ('туркмения', 'Туркменистан'), ('turkmenistan', 'Туркменистан'),
  ('tkm', 'Туркменистан'), ('tm', 'Туркменистан'), ('795', 'Туркменистан'),
  ('турция', 'Турция'), ('turkey', 'Турция'), ('türkiye', 'Турция'), ('turkiye', 'Турция'), ('tur', 'Турция'), ('tr', 'Турция'),
  ('сербия', 'Сербия'), ('serbia', 'Сербия'), ('srb', 'Сербия'), ('rs', 'Сербия'),
  ('иран', 'Иран'), ('исламская республика иран', 'Иран'), ('iran', 'Иран'), ('irn', 'Иран'), ('ir', 'Иран'),
  ('гвинея-бисау', 'Гвинея-Бисау'), ('guinea-bissau', 'Гвинея-Бисау'), ('gnb', 'Гвинея-Бисау'), ('gw', 'Гвинея-Бисау'),
  ('намибия', 'Намибия'), ('namibia', 'Намибия'), ('nam', 'Намибия'), ('na', 'Намибия'),
  ('другое', 'Другое'), ('прочее', 'Другое'), ('other', 'Другое')
) AS s(synonym, name)
JOIN public.hr_citizenships c ON c.name = s.name
ON CONFLICT (synonym) DO NOTHING;

COMMIT;
