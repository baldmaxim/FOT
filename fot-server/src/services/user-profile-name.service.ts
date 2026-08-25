// Зеркалирование ФИО карточки сотрудника в профиль портала (user_profiles.full_name).
//
// Зачем: ЛК, чат, аудит и история заявлений показывают user_profiles.full_name — отдельную
// копию ФИО, которую человек вписывает сам при регистрации. Смена фамилии в Sigur меняла
// только employees.full_name, и в ЛК оставалась старая фамилия (инцидент 25.08.2026,
// Виноходова → Чернышева).
//
// Инвариант: у профиля со связью (employee_id IS NOT NULL) full_name равен непустому
// employees.full_name; у несвязанного профиля остаётся регистрационное имя.
//
// Контракт функции:
// - принимает PoolClient, а не пул: запись обязана идти в одной транзакции с UPDATE employees.
//   Иначе проглоченная ошибка зеркала оставит расхождение навсегда — синк кладёт full_name в
//   updateFields только при отличии от prev, и следующий тик его уже не увидит;
// - каноническое имя читается прямо из employees тем же клиентом (параметра fullName нет),
//   поэтому «передали одно, в карточке другое» невозможно;
// - ошибку не глушит: вызывающий откатывает транзакцию, следующий синк повторит.

import type { PoolClient } from 'pg';

/**
 * Приводит ФИО связанных профилей к значению карточки.
 * Уникального индекса по user_profiles.employee_id нет (встречаются два профиля на одного
 * человека) — обновляются все связанные строки.
 *
 * @returns число обновлённых профилей (0 — расхождения не было либо имя в карточке пустое)
 */
export const syncProfileNameFromEmployee = async (
  client: PoolClient,
  employeeId: number,
): Promise<number> => {
  const result = await client.query(
    `UPDATE user_profiles up
     SET full_name = btrim(e.full_name)
     FROM employees e
     WHERE e.id = up.employee_id
       AND up.employee_id = $1
       AND btrim(coalesce(e.full_name, '')) <> ''
       AND btrim(coalesce(up.full_name, '')) IS DISTINCT FROM btrim(e.full_name)`,
    [employeeId],
  );
  return result.rowCount ?? 0;
};
