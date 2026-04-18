-- Удаляем дублирующиеся индексы (WARN × 3).
-- В каждой паре оставлен индекс, который backs UNIQUE-constraint (его нельзя удалить).
-- Advisor закрывает: duplicate_index × 3.

-- payslips: оставляем payslips_employee_id_period_key (backs constraint), дропаем дубль
DROP INDEX IF EXISTS public.uq_payslips_employee_period;

-- skud_daily_summary: оставляем uq_skud_summary_emp_date (backs constraint), дропаем дубль
DROP INDEX IF EXISTS public.uq_skud_daily_summary_employee_date;

-- user_profiles: оба — обычные (не constraint), оставляем idx_user_profiles_system_role_id
DROP INDEX IF EXISTS public.idx_user_profiles_system_role;
