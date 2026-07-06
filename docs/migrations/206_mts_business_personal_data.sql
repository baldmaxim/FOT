-- Миграция 206: МТС «Бизнес» — персональные данные пользователя номера.
-- 1) Журнал заявок PersonalData/ChangePersonalData (внесение/изменение/удаление)
--    — калька mts_business_action_requests (203), но СОЗНАТЕЛЬНО без payload:
--    паспортные данные уходят в МТС транзитом и нигде не сохраняются (ни в БД,
--    ни в логах, ни в аудите). Статус заявки опрашивается по message_id
--    (Operations/GetOperationResult) фоновым поллером.
-- 2) Кэш статуса подтверждения персданных (PersonalDataConfirmation) в
--    mts_business_number_map — для бейджа «Персданные» в таблице номеров без
--    живого вызова PersonalDataInfo на каждую строку. Обновляется при любом
--    живом чтении PersonalDataInfo (карточка, синк ФИО, поллер заявок).

BEGIN;

CREATE TABLE IF NOT EXISTS mts_business_personal_data_requests (
  message_id    TEXT PRIMARY KEY,      -- GUID, сгенерированный порталом (SubscriberInformation.MessageId)
  account_id    UUID REFERENCES mts_business_accounts(id) ON DELETE SET NULL,
  msisdn_hash   TEXT NOT NULL,
  msisdn_enc    TEXT,                  -- номер шифруется, как во всём модуле (AES-256-GCM)
  operation     VARCHAR(16) NOT NULL,  -- 'change' | 'delete'
  status        VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  status_detail TEXT,                  -- краткий сырой статус от МТС (без ПДн)
  requested_by  UUID,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_mts_biz_pd_requests_status
  ON mts_business_personal_data_requests (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_mts_biz_pd_requests_msisdn
  ON mts_business_personal_data_requests (msisdn_hash, requested_at DESC);

ALTER TABLE mts_business_number_map
  ADD COLUMN IF NOT EXISTS pd_status TEXT,
  ADD COLUMN IF NOT EXISTS pd_checked_at TIMESTAMPTZ;

COMMIT;
