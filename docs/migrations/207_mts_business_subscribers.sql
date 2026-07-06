-- Миграция 207: МТС «Бизнес» — вкладка «Абоненты» (полный профиль номера).
-- Особые данные (полный ответ PersonalData/PersonalDataInfo: паспорт, дата
-- рождения и т.п.) хранятся ТОЛЬКО шифром (AES-256-GCM, encryption.service) в
-- pd_data_enc и НИКОГДА не отдаются ни одним endpoint'ом — ни в UI, ни в API
-- (в т.ч. после привязки номера к сотруднику ФОТ). Держим их для полноты
-- выгрузки; наружу видны только ФИО (mts_fio) и статус подтверждения (pd_status).
--
-- Остальной профиль абонента (тариф/услуги/блокировки/переадресация/роуминг/
-- доставка/платежи/пакеты) пишется в mts_business_metric_snapshot новыми
-- значениями metric — DDL не требуется (metric TEXT).

BEGIN;

ALTER TABLE mts_business_number_map
  ADD COLUMN IF NOT EXISTS pd_data_enc TEXT,
  ADD COLUMN IF NOT EXISTS pd_synced_at TIMESTAMPTZ;

COMMIT;
