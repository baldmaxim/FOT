-- 172_matcheck_mol_list.sql
-- Представление-контракт для внешнего портала MATCHECK (приёмка материалов).
--
-- Отдаёт список МОЛ (материально-ответственных лиц) = активные начальники участка
-- компании ЛИНИЯ-Общестрой. MVP без привязки к объекту — показываем всех МОЛ.
-- Должность пишется по-разному ("Начальник участка ...", "Нач.участка",
-- "Начальник общестроительного участка"), поэтому фильтр — регулярка нач.*участ
-- (прорабов "Производитель работ (прораб)…" не задевает).
--
-- Скоуп — отдел ЛИНИЯ-Общестрой (0b24809e-...) и все его потомки, через уже
-- существующую SECURITY DEFINER функцию public.get_descendant_department_ids (миграция 083).
--
-- Доступ MATCHECK — пока через имеющийся аккаунт mcp_readonly (видит всю БД);
-- узкая роль/токен — отдельной миграцией позже.
--
-- Применяется вручную через psql на проде (авто-миграций нет). Идемпотентно.

BEGIN;

CREATE OR REPLACE VIEW public.mol_persons AS
SELECT e.id                 AS employee_id,
       e.full_name,
       e.tab_number,
       p.name               AS position_name,
       e.org_department_id   AS department_id,
       d.name               AS department_name
FROM public.employees e
JOIN public.positions p            ON p.id = e.position_id
LEFT JOIN public.org_departments d ON d.id = e.org_department_id
WHERE e.employment_status = 'active'
  AND e.is_archived = false
  AND e.org_department_id IN (
    SELECT id FROM public.get_descendant_department_ids(
      ARRAY['0b24809e-5f04-45e1-bbe2-8a82990d6bdd']::uuid[]   -- ЛИНИЯ-Общестрой
    ))
  AND lower(p.name) ~ 'нач.*участ';   -- начальники участка во всех вариантах написания

COMMIT;
