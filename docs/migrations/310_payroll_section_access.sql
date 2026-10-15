-- 310_payroll_section_access.sql
-- Раздел «Зарплата» — только людям из списка payroll_section_access.
--
-- Было: вкладка «Зарплата» в «Система → Назначения сотрудников» (персональный грант
-- «Просмотр / Редактирование», миграция 288) плюс доступ всем администраторам по роли.
-- Стало: раздел видят и правят ТОЛЬКО учётки из списка, администраторы тоже. Вкладка
-- в назначениях убрана, список ведётся в БД, в окне «Справочник» на «Расчётах» он
-- показывается только на чтение.
--
-- Ключ — UUID учётки (user_profiles.id = app_auth.users.id), а не сотрудника: у части
-- админ-учёток сотрудника нет.
--   Добавить: INSERT INTO payroll_section_access (user_id) VALUES ('<uuid>') ON CONFLICT DO NOTHING;
--   Убрать:   DELETE FROM payroll_section_access WHERE user_id = '<uuid>';
--   UUID по почте: SELECT id FROM app_auth.users WHERE lower(email) = lower('почта@пример.ru');
-- Действует со следующего запроса к API; пункт меню — после перезахода (или обновления профиля).
--
-- user_id — владение (строка принадлежит учётке): ON DELETE CASCADE (политика 284/285,
-- стережёт npm run audit:user-fk).
--
-- Права ролей на ключи раздела (/salary/payments, /salary/terms, …) больше ничего не дают.
-- Из матрицы «Роли» ключи убирает код (фильтр каталога в access-control.service), а строки
-- role_page_access удаляются здесь, чтобы не висели мёртвые гранты.
-- /salary-raise-review («Повышение оклада») — другой раздел, не трогается.
-- payroll_access_grants (288) удаляется: на проде строк нет.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд без таблицы никого в раздел не пустит
-- (ошибка БД = «нет доступа»). Прежний бэкенд после миграции работает: админы видят раздел
-- по роли, как раньше, панель назначений на вкладке «Зарплата» покажет ошибку загрузки.
-- Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS public.payroll_section_access (
  user_id uuid PRIMARY KEY REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payroll_section_access IS
  'Кому доступен раздел «Зарплата» (весь, с правкой). Кого нет в списке — раздела нет, в том числе у администраторов.';

-- Стартовый список. Отсутствующие id (локальная/тестовая БД) пропускаются.
INSERT INTO public.payroll_section_access (user_id)
SELECT id
  FROM public.user_profiles
 WHERE id IN (
   'e990ba9c-1288-4d3c-98c1-c5796132d61f',  -- Есенов Максим АДМ
   'b793cded-213f-4669-8ad6-1ee12a8e3ba5',  -- Постоев Админ
   '491c989c-ad9e-4fe0-836b-3559fd5a4dfc',  -- Масеева Алла Амировна
   '8e06acdb-bbfd-4a59-a808-8a80cd9c603f',  -- Пашаева Луарат Рамазановна
   'a51b9047-273c-445f-bf7a-e186ced3f65d'   -- Чепиков Павел Владимирович
 )
ON CONFLICT (user_id) DO NOTHING;

DELETE FROM public.role_page_access
 WHERE page_path IN (
   '/salary/payments',
   '/salary/payments/calculate',
   '/salary/payments/approve',
   '/salary/terms',
   '/salary/sick-leaves',
   '/salary/vacations',
   '/salary/deductions'
 );

DROP TABLE IF EXISTS public.payroll_access_grants;

COMMIT;
