-- 331: Зарплата — основа расчёта к редакции закрытого табеля + способ округления оклада.
--
-- Зачем. ФОТ считает «К выплате» за месяц по закрытому табелю. В версии табеля (timesheet_versions.payload)
-- есть статус и часы дня, но нет нормы и графика, а графики меняют задним числом: за июнь 2026 75 из 147
-- назначений внесены после закрытия месяца, 7 шаблонов из 39 в октябре правились на месте. Без снимка оклад
-- закрытого месяца менялся бы вслед за графиком.
--
-- timesheet_version_payroll_basis — неизменяемый снимок по (редакция, сотрудник, месяц): норма дней и часов месяца,
-- рабочие дни для оклада, выходы в выходные, часы переработки в будни по корректировкам, дни отсутствий. Пишется при утверждении/закрытии подачи рядом
-- со снимками объектов и руководителей; payload, content_hash, редакции и ACK для 1С не трогает. Повторное
-- закрытие с другим графиком даёт новую revision, прежние строки не меняются и не удаляются.
-- quality: materialized — снят при закрытии; reconstructed — дозаполнен скриптом по графикам на дату запуска.
--
-- payroll_compensation_terms.proration_rounding — как ЗУП округляет оклад за неполный месяц:
--   ruble        — (оклад × дни / норма), половина вверх до рубля (август 2026: 200 человек);
--   daily_kopeck — дневная ставка до копейки × дни (43 человека: 250 000 / 21 = 11 904,76 × 11 = 130 952,36).
-- Часть условий: меняется вместе с ними и историчен так же.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Без таблицы бэкенд закрывает табели как раньше (запись основы под SAVEPOINT),
-- но «К выплате (ФОТ)» не считается. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS timesheet_version_payroll_basis (
  id            BIGSERIAL PRIMARY KEY,
  version_id    BIGINT  NOT NULL REFERENCES timesheet_versions(id) ON DELETE CASCADE,
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month         DATE    NOT NULL,
  revision      INTEGER NOT NULL DEFAULT 1,
  basis_hash    TEXT    NOT NULL,
  norm_days     INTEGER,
  norm_minutes  INTEGER,
  workday_dates DATE[]  NOT NULL DEFAULT '{}',
  dayoff_dates  DATE[]  NOT NULL DEFAULT '{}',
  absence_days  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  overtime_minutes JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality       TEXT    NOT NULL CHECK (quality IN ('materialized', 'reconstructed')),
  reason        TEXT    NOT NULL CHECK (reason IN ('close', 'rebuild', 'backfill')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payroll_basis_month CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT payroll_basis_revision CHECK (revision >= 1),
  CONSTRAINT payroll_basis_norm CHECK (norm_days IS NULL OR norm_days >= 0),
  CONSTRAINT payroll_basis_norm_minutes CHECK (norm_minutes IS NULL OR norm_minutes >= 0),
  CONSTRAINT payroll_basis_unique UNIQUE (version_id, employee_id, month, revision)
);

-- Колонки часов добавлены в 331 до её первого применения; базы, где 331 уже прошла без них, — догоняем.
ALTER TABLE timesheet_version_payroll_basis ADD COLUMN IF NOT EXISTS norm_minutes INTEGER;
ALTER TABLE timesheet_version_payroll_basis ADD COLUMN IF NOT EXISTS overtime_minutes JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS payroll_basis_employee_month
  ON timesheet_version_payroll_basis (employee_id, month);

COMMENT ON TABLE timesheet_version_payroll_basis IS
  'Основа расчёта «К выплате (ФОТ)» к редакции табеля: норма дней месяца и дни сотрудника, классифицированные '
  'по графику на момент закрытия. Неизменяема: новая revision — только при другом basis_hash. См. миграцию 331.';
COMMENT ON COLUMN timesheet_version_payroll_basis.norm_days IS
  'Норма дней месяца: дни графика своего дня + плановые Сб/Вс графика последнего дня; нет графика хоть на день — '
  'норма производственного календаря; NULL — нет и её.';
COMMENT ON COLUMN timesheet_version_payroll_basis.workday_dates IS
  'Отработанные дни для оклада (правило колонки «Дни» единого 1С) — дни графика и плановые Сб/Вс в квоте.';
COMMENT ON COLUMN timesheet_version_payroll_basis.dayoff_dates IS
  'Выходы в выходные: день вне графика, статус work/remote/manual, часы > 0 (несогласованные выгрузка обнуляет).';
COMMENT ON COLUMN timesheet_version_payroll_basis.norm_minutes IS
  'Норма часов месяца в минутах — производственного календаря, как ЗУП (у графика с 7-часовой пятницей 164 ч, '
  'а ЗУП делит на 168); календаря нет — часы графика + плановые Сб/Вс; NULL — нет и их. Знаменатель часовой переработки.';
COMMENT ON COLUMN timesheet_version_payroll_basis.overtime_minutes IS
  'Переработка в будни по корректировкам: {"YYYY-MM-DD": минуты} — часы 1С дня с правкой часов сверх нормы дня. '
  'СКУД сверх графика без корректировки сюда не идёт.';
COMMENT ON COLUMN timesheet_version_payroll_basis.absence_days IS
  'Дни отсутствий подачи: {"vacation": n, "sick": n, "educational_leave": n, "unpaid": n}.';

REVOKE ALL ON TABLE public.timesheet_version_payroll_basis FROM PUBLIC;

ALTER TABLE payroll_compensation_terms
  ADD COLUMN IF NOT EXISTS proration_rounding TEXT NOT NULL DEFAULT 'ruble';
ALTER TABLE payroll_compensation_terms DROP CONSTRAINT IF EXISTS payroll_terms_proration_rounding;
ALTER TABLE payroll_compensation_terms ADD CONSTRAINT payroll_terms_proration_rounding
  CHECK (proration_rounding IN ('ruble', 'daily_kopeck'));

COMMENT ON COLUMN payroll_compensation_terms.proration_rounding IS
  'Округление оклада за неполный месяц, как в ЗУП: ruble — сумма до рубля (половина вверх), daily_kopeck — '
  'дневная ставка до копейки × дни. См. миграцию 331.';

COMMIT;
