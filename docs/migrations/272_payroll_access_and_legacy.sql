-- 272: Раздел «Зарплата» — ключи доступа + вывод legacy-контура расчётных листков.
--
-- Ключи выдаются по мере готовности этапов: подтверждение выплат, больничные, отпуска
-- и удержания придут со своими миграциями. Заводить ключ раньше экрана нельзя —
-- контракт-тест каталога считает такой ключ orphan.
--
-- Доступ. На первом этапе раздел открыт ТОЛЬКО роли admin, но ограничение реализовано
-- через role_page_access, а не жёстким флагом в коде. Ключи заведены раздельно (просмотр,
-- запуск расчёта, проверка расчёта, подтверждение выплаты, условия оплаты, больничные,
-- отпуска, удержания, утверждение удержаний), чтобы администратор позже открыл нужные
-- возможности другим ролям через админку — без миграции и деплоя.
--
-- group_code обязан совпадать с DEFAULT_ACCESS_PAGE_CATALOG в
-- fot-server/src/config/access-control.ts: запись в БД переопределяет программный каталог,
-- а расхождение ловит access-page-catalog-contract.test.ts.
--
-- Legacy. payslips считались формулой salary / norm_days * worked_days с нормой из
-- production_calendar и НДФЛ хардкодом 0.13. Для сменных графиков (6+0 по 11 ч — 1072
-- человека, циклы 15/15) это неверно. Обе таблицы пусты, терять нечего. Страница гасится
-- здесь, роуты снимаются в коде — скрытия страницы мало: /payslips/my защищён ключом
-- /employee, а роль admin обходит page-access.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- ── 1. Страницы раздела ─────────────────────────────────────────────────────
INSERT INTO access_pages
  (key, label, group_code, group_label, area, surface, supports_edit, sort_order, is_active, is_system)
VALUES
  ('/salary/payments',           'Зарплата — Выплаты',                       'admin', 'Администрирование', 'admin', 'page',      true,  270, true, true),
  ('/salary/payments/calculate', 'Зарплата — запуск расчёта',                'admin', 'Администрирование', 'admin', 'technical', true,  271, true, true),
  ('/salary/payments/approve',   'Зарплата — проверка расчёта',              'admin', 'Администрирование', 'admin', 'technical', true,  272, true, true),
  ('/salary/terms',              'Зарплата — условия оплаты',                'admin', 'Администрирование', 'admin', 'technical', true,  274, true, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  area = EXCLUDED.area,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- ── 2. Права: только admin ──────────────────────────────────────────────────
--
-- Никаких hr_admin/economist: расчёт ещё не сверен с 1С. Раздать права другим ролям
-- можно будет в /admin/roles, эта миграция для этого не нужна.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT 'admin', k, true, true
  FROM unnest(ARRAY[
    '/salary/payments','/salary/payments/calculate','/salary/payments/approve','/salary/terms'
  ]) AS k
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = true, can_edit = true;

-- Страховка от повторного прогона после ручной раздачи прав в UI: если кто-то выдал
-- ключи /salary/* другим ролям осознанно, миграция их НЕ трогает. Снимаем только то,
-- что могло приехать копированием из соседних страниц в других миграциях.
-- (Явного удаления нет намеренно — иначе повторный прогон отобрал бы выданные права.)

-- ── 3. Гашение legacy-страницы расчётных листков ────────────────────────────
UPDATE access_pages
   SET is_active = false, updated_at = now()
 WHERE key = '/admin/payslips' AND is_active;

-- ── 4. Права на новые таблицы ───────────────────────────────────────────────
--
-- Перечислением, а не REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC:
-- последнее затронуло бы всю схему и сломало соседние модули.
REVOKE ALL ON TABLE public.payroll_compensation_terms FROM PUBLIC;
REVOKE ALL ON TABLE public.payroll_item_types         FROM PUBLIC;
REVOKE ALL ON TABLE public.payroll_settings           FROM PUBLIC;

COMMIT;
