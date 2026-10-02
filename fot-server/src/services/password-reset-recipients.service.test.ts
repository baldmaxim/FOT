import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Получатели «Запрос на сброс пароля»: системные админы (как раньше) и кадровый админ —
 * не-админская роль с глобальным скоупом данных и edit «Пользователей».
 * Фильтр по скоупу/одобрению делает SQL, право страницы — кэш ролей (hasPageEdit).
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  hasPageEdit: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query }));
vi.mock('./access-control.service.js', () => ({ hasPageEdit: h.hasPageEdit }));

import { listPasswordResetRecipientIds } from './password-reset-recipients.service.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.hasPageEdit.mockImplementation(async (roleCode: string, page: string) =>
    roleCode === 'hr_admin' && page === '/admin/users');
});

describe('listPasswordResetRecipientIds', () => {
  it('SQL: исключает автора запроса, админов компании, неодобренных и роли без глобального скоупа', async () => {
    h.query.mockResolvedValue([]);
    await listPasswordResetRecipientIds('requester-uuid');

    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['requester-uuid']);
    expect(sql).toContain('up.id <> $1::uuid');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM user_company_access');
    expect(sql).toContain('sr.all_departments_scope = true');
    expect(sql).toContain('up.is_approved = true');
  });

  it('системный админ — всегда, кадровый админ — при edit «Пользователей»', async () => {
    h.query.mockResolvedValue([
      { id: 'u-admin', role_code: 'admin', is_admin: true },
      { id: 'u-hr-admin-1', role_code: 'hr_admin', is_admin: false },
      { id: 'u-hr-admin-2', role_code: 'hr_admin', is_admin: false },
    ]);
    await expect(listPasswordResetRecipientIds('requester-uuid'))
      .resolves.toEqual(['u-admin', 'u-hr-admin-1', 'u-hr-admin-2']);
    // Право страницы считается один раз на роль.
    expect(h.hasPageEdit).toHaveBeenCalledTimes(1);
  });

  it('глобальный скоуп без edit «Пользователей» — не получатель', async () => {
    h.query.mockResolvedValue([
      { id: 'u-scope-only', role_code: 'scope_only', is_admin: false },
    ]);
    await expect(listPasswordResetRecipientIds('requester-uuid')).resolves.toEqual([]);
    expect(h.hasPageEdit).toHaveBeenCalledWith('scope_only', '/admin/users');
  });
});
