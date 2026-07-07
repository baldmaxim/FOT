-- 208: МТС Бизнес — чистка мусорных ФИО «null null» в number_map.
--
-- Корень: МТС для корпоративных SIM без владельца возвращает в PersonalDataInfo
-- поле name = литеральную строку «null null». Парсер до фикса принимал её как
-- валидное ФИО и сохранял в mts_fio (786 из 1519 номеров на проде). В карточке
-- абонента это выводилось как ФИО. Парсер исправлен (isPlaceholderName в
-- mts-business-personal-data.service.ts) — новые синки такое не занесут; эта
-- миграция чистит уже накопленное.
--
-- Применять вручную (авто-миграций в проекте нет):
--   psql "$DATABASE_URL" -f docs/migrations/208_mts_business_fix_null_fio.sql

UPDATE mts_business_number_map
   SET mts_fio = NULL
 WHERE mts_fio ~* '^(null|undefined)( +(null|undefined))*$';
