-- 176: удалить зарплатные данные (Ставка/Оклад) и историю ТОЛЬКО по зарплате.
--
-- На карточке сотрудника в блоке «Трудоустройство» у части людей показывались
-- строки «Ставка» (employees.staff_units) и «Оклад» (employees.current_salary).
-- Решено убрать эти данные из БД вместе с историей изменений ИМЕННО по зарплате;
-- остальной аудит и история (переводы/назначения и пр.) — без изменений.
--
-- На 2026-06-09 затронуто 28 сотрудников в 5 отделах (Тендерный — 21,
-- Системного Анализа — 3, Уволенные — 2, Сметно-технический — 1, Юридический — 1)
-- и 136 строк salary_history. Идемпотентно: повторный прогон ничего не находит.

-- 1) обнулить зарплатные колонки в employees (staff_units → NULL, чтобы строка
--    «Ставка» исчезла с карточки; рендер на фронте показывает поле только при != null)
UPDATE public.employees
   SET current_salary    = NULL,
       salary_actual     = NULL,
       salary_calculated = NULL,
       staff_units       = NULL,
       updated_at        = now()
 WHERE current_salary IS NOT NULL
    OR salary_actual IS NOT NULL
    OR salary_calculated IS NOT NULL
    OR (staff_units IS NOT NULL AND staff_units <> 0);

-- 2) удалить зарплатную историю (таблица целиком про зарплату)
DELETE FROM public.salary_history;

-- 3) убрать ТОЛЬКО зарплатные записи из общего аудита; прочий аудит сохраняем
DELETE FROM public.audit_logs WHERE action = 'UPDATE_SALARY';
