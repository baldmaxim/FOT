-- 205: комментарий номера из ЛК МТС (Service/GetCommentsByMSISDN).
-- Вспомогательный источник имени/заметки, когда PersonalData/PersonalDataInfo
-- пуст (корп-SIM без внесённых персданных физлица). Это заметка администратора
-- в ЛК МТС (напр. «Иванов Иван / отдел продаж»), а не юридические ПДн —
-- хранится открыто, как и mts_fio. НЕ путать с mts_fio (данные PersonalData/XML).
ALTER TABLE mts_business_number_map ADD COLUMN IF NOT EXISTS mts_comment TEXT;

COMMENT ON COLUMN mts_business_number_map.mts_comment IS
  'Комментарий номера из ЛК МТС (Service/GetCommentsByMSISDN) — вспомогательная заметка/имя, fallback к ФИО.';
