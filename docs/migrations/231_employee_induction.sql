-- 231_employee_induction.sql
-- Вводный инструктаж собственных сотрудников (СУ-10 + Служба Механизации).
--
-- Аналог реестра подрядчиков (contractor_inducted_persons, миграция 213), но для
-- своих: вкладка «Вводный инструктаж» в разделе «Управление кадрами». Дату
-- проставляет служба ОТиТБ (роль otitb из 209). Галочек нет: есть дата — инструктаж
-- пройден, нет даты — не пройден.
--
-- Одна текущая дата на сотрудника (инструктаж однократен) → PK по employee_id,
-- снятие даты = DELETE. Отдельная таблица, а не колонка employees: не трогаем
-- горячую таблицу и её кэши, синк Sigur ничего не перетирает.
--
-- Следствия схемы (осознанно):
--   * перевод между отделами дату сохраняет (ключ — сотрудник, не отдел);
--   * увольнение/архивирование прячет строку из списка, но дату сохраняет;
--   * повторный приём на тот же профиль сохраняет старую дату (инструктаж
--     однократен навсегда; ОТиТБ при необходимости перебивает дату вручную);
--   * удаление сотрудника из БД чистит запись каскадом.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

-- 1. Реестр дат вводного инструктажа.
CREATE TABLE IF NOT EXISTS public.employee_inductions (
  employee_id integer     PRIMARY KEY REFERENCES public.employees(id) ON DELETE CASCADE,
  inducted_on date        NOT NULL,
  updated_by  uuid        NULL,          -- app_auth.users.id, без жёсткого FK (как в 213)
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.employee_inductions IS
  'Дата вводного инструктажа сотрудника (ОТиТБ). Одна актуальная дата на сотрудника; снятие = DELETE.';

-- 2. Технический ключ вкладки в каталоге страниц (как /admin/contractor-approvals/otitb в 213).
--    surface='technical' — отдельным пунктом меню не показывается, но участвует в матрице доступа.
INSERT INTO access_pages (key, label, group_code, group_label, area, surface, supports_edit, sort_order, is_active)
VALUES
  ('/staff-control/induction', 'Управление кадрами — Вводный инструктаж (вкладка)',
   'work', 'Управление', 'admin', 'technical', true, 106, true)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  area = EXCLUDED.area,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

-- 3. Доступ роли ОТиТБ: просмотр + правка дат. Полный ключ /staff-control ей НЕ даём —
--    ростер «Текущие сотрудники» и «Заявки на поиск сотрудников» остаются закрытыми.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('otitb', '/staff-control/induction', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
