// Кому уходит уведомление «Запрос на сброс пароля»: тем, кто выдаёт ссылку сброса из
// очереди регистраций (см. canManagePendingUsers в admin-users.controller).
//  - системный админ (is_admin без привязки к компаниям) — как раньше;
//  - кадровый админ: не-админская роль с глобальным скоупом данных (all_departments_scope,
//    миграция 270) и edit «Пользователей». Право страницы — через кэш ролей (hasPageEdit),
//    а не JOIN по role_page_access: правило доступа к страницам живёт в одном месте.
// Админ компании уведомление не получает: очередь регистраций ему не открыта.

import { query } from '../config/postgres.js';
import { hasPageEdit } from './access-control.service.js';

const USERS_PAGE_KEY = '/admin/users';

export async function listPasswordResetRecipientIds(excludeUserId: string): Promise<string[]> {
  const rows = await query<{ id: string; role_code: string; is_admin: boolean }>(
    `SELECT up.id, sr.code AS role_code, sr.is_admin
       FROM user_profiles up
       JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE up.id <> $1::uuid
        AND (
          (sr.is_admin = true
            AND NOT EXISTS (SELECT 1 FROM user_company_access uca WHERE uca.user_id = up.id))
          OR (sr.is_admin = false
            AND sr.all_departments_scope = true
            AND up.is_approved = true)
        )`,
    [excludeUserId],
  );

  const editByRole = new Map<string, boolean>();
  const recipientIds: string[] = [];
  for (const row of rows) {
    if (row.is_admin) {
      recipientIds.push(row.id);
      continue;
    }
    if (!editByRole.has(row.role_code)) {
      editByRole.set(row.role_code, await hasPageEdit(row.role_code, USERS_PAGE_KEY));
    }
    if (editByRole.get(row.role_code)) recipientIds.push(row.id);
  }
  return recipientIds;
}
