-- 262: флаг роли «KPI объектов: только закреплённые объекты».
-- Применять ДО деплоя бэкенда.
--
-- До этого право на страницу /discipline/objects означало «вся стройка»: экономист
-- объекта видел план/факт/договоры/КС-2 и премии руководителей по всем объектам и мог
-- менять данные любого объекта (object-kpi-scope.service.ts, ветка «Этап 1»).
-- С флагом скоуп роли — только объекты её закреплений object_economist в
-- object_kpi_assignments. Расчёты не меняются, меняется только разграничение доступа.
-- Управление закреплениями остаётся у администратора и руководителя эк. отдела.

BEGIN;

ALTER TABLE public.system_roles
  ADD COLUMN IF NOT EXISTS object_kpi_own_objects_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_roles.object_kpi_own_objects_only IS
  'KPI объектов: роль видит и правит только объекты своих закреплений object_economist (object_kpi_assignments), а не всю стройку. Для is_admin не действует.';

-- Экономисты объектов: у всех действующих пользователей роли есть закрепления (проверено 01.09.2026).
UPDATE public.system_roles
   SET object_kpi_own_objects_only = true
 WHERE code = 'economist' AND is_admin = false;

COMMIT;
