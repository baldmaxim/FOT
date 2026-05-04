-- Миграция 076: блокировка перезаписи ФИО из Sigur для отдельных сотрудников.
--
-- Зачем: parseFIO() жёстко режет full_name по пробелам (last=parts[0], first=parts[1],
-- middle=остальное). Для сотрудников с нестандартными ФИО (несколько имён без отчества,
-- иностранцы и т.п.) этот split ломает отображение. Часовой sigur-структурный синк
-- перезаписывал ручные правки. Теперь, если name_locked=true, синк не трогает
-- full_name / last_name / first_name / middle_name. Снимается прямым UPDATE.

ALTER TABLE employees
  ADD COLUMN name_locked BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN employees.name_locked IS
  'Если true — sigur-синк не перезаписывает full_name/last_name/first_name/middle_name. Используется для нестандартных ФИО, которые не вписываются в split parseFIO (фамилия = первое слово, имя = второе, отчество = остальное).';

-- Точечная блокировка для сотрудника «Луис Дженс Жоаким Матиас» (id=1010, sigur_employee_id=128342):
UPDATE employees
SET full_name   = 'Луис Дженс Жоаким Матиас',
    last_name   = 'Луис',
    first_name  = 'Дженс Жоаким Матиас',
    middle_name = NULL,
    name_locked = true,
    updated_at  = NOW()
WHERE id = 1010 AND sigur_employee_id = 128342;
