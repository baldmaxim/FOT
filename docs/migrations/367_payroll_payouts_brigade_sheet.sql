-- 367: «Выплаты на карту» — выплаты по ведомости бригады и перенос строки выплаты в другой месяц.
--
-- Зачем. Рабочим бригад за сентябрь 2026 1С перечислила только часть Л/С (аванс и зарплата по общим зарплатным
-- проектам, ведомостей «ЗП проект рабочие» в выгрузке нет), часть сентябрьского Л/С оплатила октябрьскими
-- «Увольнениями», а «К выдаче» через банк не проходит вовсе. Решение пользователя 17.11.2026: выплаты рабочих за месяц —
-- по «Расчётным ведомостям» бригад (Л/С + «К выдаче»; 27.10: «К выплате — выплачено»), чтобы «Остаток» был 0.
--
--   * documents.source: '1c' — ведомость 1С (все прежние); 'brigade_sheet' — выплата по ведомости бригады (упр.),
--     которой нет в выгрузке 1С (Л/С сверх 1С, «К выдаче»). Грузит только скрипт; кнопка «Загрузить из 1С» её не меняет.
--   * lines.period_month: месяц, за который выплата, если он отличается от месяца ведомости 1С (решение пользователя:
--     октябрьская строка «Увольнения», оплатившая сентябрь). Месяц строки везде = COALESCE(l.period_month, d.period_month).
--     lines.period_month_reason — почему; resolution_reason по-прежнему только причина сопоставления сотрудника.
--     Документ с такой строкой кнопка «Загрузить из 1С» не заменяет (409): замена пересоздаёт строки и потеряла бы месяц.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд читает source и period_month. Прежний бэкенд с ней работает (столбцы
-- с умолчаниями), но перенесённую строку покажет в месяце ведомости — SQL выплат запускать после деплоя.
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_1c_payout_documents
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '1c';
ALTER TABLE payroll_1c_payout_documents DROP CONSTRAINT IF EXISTS payroll_1c_payout_documents_source_check;
ALTER TABLE payroll_1c_payout_documents ADD CONSTRAINT payroll_1c_payout_documents_source_check
  CHECK (source IN ('1c', 'brigade_sheet'));

ALTER TABLE payroll_1c_payout_lines
  ADD COLUMN IF NOT EXISTS period_month DATE,
  ADD COLUMN IF NOT EXISTS period_month_reason TEXT;
ALTER TABLE payroll_1c_payout_lines DROP CONSTRAINT IF EXISTS payroll_1c_payout_lines_period_month_check;
ALTER TABLE payroll_1c_payout_lines ADD CONSTRAINT payroll_1c_payout_lines_period_month_check CHECK (
  (period_month IS NULL AND period_month_reason IS NULL)
  OR (period_month IS NOT NULL AND period_month_reason IS NOT NULL
      AND period_month = date_trunc('month', period_month)::date
      AND btrim(period_month_reason) <> '' AND length(period_month_reason) <= 300));

-- Выборки «Перечислено (1С)» за месяц идут по месяцу строки.
CREATE INDEX IF NOT EXISTS payroll_1c_payout_lines_period_month_idx
  ON payroll_1c_payout_lines (period_month) WHERE period_month IS NOT NULL;

COMMENT ON COLUMN payroll_1c_payout_documents.source IS
  '1c — ведомость выплаты из 1С; brigade_sheet — выплата по «Расчётной ведомости» бригады (упр.), которой нет в выгрузке '
  '1С: Л/С сверх 1С и «К выдаче» (решение пользователя 17.11.2026). Грузит только скрипт (367).';
COMMENT ON COLUMN payroll_1c_payout_lines.period_month IS
  'Месяц, за который выплата, если отличается от месяца ведомости (period_month документа); NULL — как у документа. '
  'Месяц строки = COALESCE(l.period_month, d.period_month) (367).';
COMMENT ON COLUMN payroll_1c_payout_lines.period_month_reason IS
  'Почему строка отнесена к другому месяцу (решение пользователя); заполнен вместе с period_month (367).';

COMMIT;
