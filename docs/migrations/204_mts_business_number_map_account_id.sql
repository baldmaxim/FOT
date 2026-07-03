-- Миграция 204: МТС «Бизнес» — account_id в number_map. Номера, найденные
-- через структуру абонента (HierarchyStructure, Фаза 2), заводились в
-- mts_business_number_map без привязки к аккаунту — из-за этого циклы синка
-- баланса/тарифа по номерам (источник — только mts_business_cdr.account_id)
-- их не видели, даже после ручной привязки к сотруднику. Столбец нужен, чтобы
-- «известные номера аккаунта» строились из CDR И number_map вместе.

BEGIN;

ALTER TABLE mts_business_number_map
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_mts_business_number_map_account
  ON mts_business_number_map (account_id);

COMMIT;
