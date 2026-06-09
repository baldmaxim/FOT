-- 174: убрать привязки user_company_access к НЕАКТИВНЫМ узлам org_departments.
--
-- Такая строка делает системного админа company-admin «в пустоту»: скоуп
-- считается как subtree указанного узла, а у неактивного узла после реорга
-- Sigur потомков нет — у пользователя пропадают сотрудники, табель, заявления,
-- пункт «Система», а contractor-эндпоинты отдают 403 (ensureSystemAdmin требует
-- roots === 'all'). Код трактует любого is_admin с >=1 строкой как company-admin;
-- пустой список дал бы 'all'. Осиротевшая привязка остаётся, т.к. реорг лишь
-- помечает узел is_active=false, не трогая user_company_access.
--
-- На 2026-06-09 затронут только Фетисова А.А. (узел «Допуск Везде»).
-- Идемпотентно: повторный прогон строк не находит.

DELETE FROM public.user_company_access uca
USING public.org_departments d
WHERE d.id = uca.company_root_id
  AND d.is_active = false;
