-- 248_object_kpi_assignment_salary.sql
-- Зарплата руководителя строительства в строке закрепления объекта.
--
-- Оклад привязан к закреплению, а не к человеку: он назначается за конкретный объект и
-- период ответственности. В ЛК руководителя он показывается рядом с премией и складывается
-- с ней в «Итого» — считает пропорцию по дням закрепления SQL премии (object-kpi-premium.service.ts).
--
-- ВНИМАНИЕ: отдельной истории ставок у строки нет. Правка salary_amount пересчитывает
-- зарплату во ВСЕХ месяцах закрепления задним числом. Если ставка меняется с конкретного
-- месяца — закрыть прежнее закрепление датой «по» и завести новое с новой суммой.
--
-- Видимость: значение хранится полностью, но наружу отдаётся только администратору и
-- руководителю экономического отдела (object-kpi-salary-access.service.ts). Экономист
-- объекта, открывающий ту же модалку «Назначения», получает null.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE public.object_kpi_assignments
  ADD COLUMN IF NOT EXISTS salary_amount numeric(15,2);

-- CHECK, а не только проверка в коде: «оклад у экономиста объекта» — не ошибка ввода,
-- а состояние, которого не должно существовать физически. Экономистам зарплата в этом
-- контуре не ведётся (решение пользователя), и ошибка формы не должна её туда занести.
ALTER TABLE public.object_kpi_assignments
  DROP CONSTRAINT IF EXISTS object_kpi_assignments_salary_check;

ALTER TABLE public.object_kpi_assignments
  ADD CONSTRAINT object_kpi_assignments_salary_check
  CHECK (salary_amount IS NULL
         OR (salary_amount >= 0 AND role_kind = 'construction_manager'));

COMMIT;
