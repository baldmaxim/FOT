-- Корректировка часов не больше графика — для всех ролей.
-- Предел дня: норма по графику, в нерабочий день графика — длина смены (getCorrectionCapHours).
-- Строки табеля не меняются: старые правки сверх графика остаются. Галочка в «Роли» остаётся,
-- новая роль создаётся с ней.
--
-- Порядок деплоя строгий: бэкенд → 343 → (через 5 минут) фронтенд. Старый бэкенд считает
-- предел по норме дня и с этой миграцией запретил бы все правки в выходные.
--
-- Откат — сначала флаги, потом бэкенд:
--   UPDATE public.system_roles SET corrections_cap_by_schedule_norm = false WHERE code <> 'site_supervisor';
--   ALTER TABLE public.system_roles ALTER COLUMN corrections_cap_by_schedule_norm SET DEFAULT false;

UPDATE public.system_roles SET corrections_cap_by_schedule_norm = true;

ALTER TABLE public.system_roles ALTER COLUMN corrections_cap_by_schedule_norm SET DEFAULT true;
