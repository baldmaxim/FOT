import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';

/**
 * Политика назначаемых ролей (миграция 270): что не-админ вправе выдавать и чьи
 * учётные записи ему позволено трогать.
 *
 * Список — allowlist: важно зафиксировать, что новая роль по умолчанию НЕ
 * назначаема, иначе очередная техническая роль молча стала бы доступной для выдачи.
 */

const { getRoleByCode, queryOne } = vi.hoisted(() => ({
  getRoleByCode: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('./roles-cache.service.js', () => ({ getRoleByCode }));
vi.mock('../config/postgres.js', () => ({ queryOne }));

import {
  checkRoleAssignable,
  checkTargetUserManageable,
  isRoleAssignableByNonAdmin,
} from './assignable-roles.service.js';

const role = (overrides: Partial<SystemRole> = {}): SystemRole => ({
  is_admin: false,
  all_departments_scope: false,
  ...overrides,
} as SystemRole);

const req = (isAdmin: boolean): AuthenticatedRequest => ({
  user: { id: 'u1', is_admin: isAdmin, role_code: isAdmin ? 'admin' : 'hr_admin' },
} as unknown as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  getRoleByCode.mockImplementation(async (code: string) => role({ code } as Partial<SystemRole>));
});

describe('isRoleAssignableByNonAdmin', () => {
  it('обычные рабочие роли — назначаемы', async () => {
    for (const code of ['office', 'worker', 'contractor', 'manager', 'manager_obj',
      'site_supervisor', 'timekeeper', 'hr', 'economist', 'otitb', 'mts_manager']) {
      expect(await isRoleAssignableByNonAdmin(code)).toBe(true);
    }
  });

  it('админ, кадровый админ и технические роли — нет', async () => {
    for (const code of ['admin', 'hr_admin', 'security', 'checks']) {
      expect(await isRoleAssignableByNonAdmin(code)).toBe(false);
    }
  });

  it('роль вне allowlist не назначаема, даже если выглядит безобидно', async () => {
    expect(await isRoleAssignableByNonAdmin('brand_new_role')).toBe(false);
  });

  it('роль из allowlist, ставшая админской, отсекается runtime-страховкой', async () => {
    getRoleByCode.mockResolvedValue(role({ is_admin: true }));
    expect(await isRoleAssignableByNonAdmin('office')).toBe(false);
  });

  it('роль из allowlist с глобальным скоупом данных тоже отсекается', async () => {
    getRoleByCode.mockResolvedValue(role({ all_departments_scope: true }));
    expect(await isRoleAssignableByNonAdmin('office')).toBe(false);
  });

  it('пустой код и несуществующая роль — нет', async () => {
    expect(await isRoleAssignableByNonAdmin(null)).toBe(false);
    getRoleByCode.mockResolvedValue(null);
    expect(await isRoleAssignableByNonAdmin('office')).toBe(false);
  });
});

describe('checkRoleAssignable', () => {
  it('админ выдаёт что угодно, включая админскую роль', async () => {
    expect(await checkRoleAssignable(req(true), 'admin')).toBeNull();
  });

  it('не-админ получает отказ на неназначаемую роль', async () => {
    expect(await checkRoleAssignable(req(false), 'admin')).toContain('недоступна');
  });

  it('не-админ выдаёт роль из allowlist', async () => {
    expect(await checkRoleAssignable(req(false), 'office')).toBeNull();
  });
});

describe('checkTargetUserManageable', () => {
  it('админа пропускаем без запроса в БД', async () => {
    expect(await checkTargetUserManageable(req(true), 'target')).toEqual({ ok: true });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('не-админ не трогает учётку администратора', async () => {
    queryOne.mockResolvedValue({ role_code: 'admin' });
    const result = await checkTargetUserManageable(req(false), 'target');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('не-админ не трогает учётку такого же кадрового админа', async () => {
    queryOne.mockResolvedValue({ role_code: 'hr_admin' });
    expect(await checkTargetUserManageable(req(false), 'target')).toMatchObject({ ok: false, status: 403 });
  });

  it('обычного пользователя — можно', async () => {
    queryOne.mockResolvedValue({ role_code: 'office' });
    expect(await checkTargetUserManageable(req(false), 'target')).toEqual({ ok: true });
  });

  it('профиль без роли не трогаем: неизвестно, что выдаём', async () => {
    queryOne.mockResolvedValue({ role_code: null });
    expect(await checkTargetUserManageable(req(false), 'target')).toMatchObject({ ok: false, status: 403 });
  });

  it('несуществующий пользователь — 404', async () => {
    queryOne.mockResolvedValue(null);
    expect(await checkTargetUserManageable(req(false), 'target')).toMatchObject({ ok: false, status: 404 });
  });
});
