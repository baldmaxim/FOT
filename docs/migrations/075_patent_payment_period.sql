-- Период оплаты патента: с какого по какое число оплачен патент по чеку.
-- Указывается рабочим при загрузке чека (обязательные поля на UI), нужен админу
-- для понимания, за какой месяц/период пришла оплата. Старые чеки остаются с NULL.

ALTER TABLE patent_payment_receipts
  ADD COLUMN IF NOT EXISTS period_start DATE NULL,
  ADD COLUMN IF NOT EXISTS period_end   DATE NULL;

COMMENT ON COLUMN patent_payment_receipts.period_start IS
  'Начало периода, за который оплачен патент (указывается рабочим при загрузке чека).';
COMMENT ON COLUMN patent_payment_receipts.period_end IS
  'Конец периода, за который оплачен патент (указывается рабочим при загрузке чека).';
