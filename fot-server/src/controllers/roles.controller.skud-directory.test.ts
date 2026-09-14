import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Выдача и снятие ключа /skud-settings/directory через матрицу ролей (PUT
 * /api/roles/:code/access-profile) для «Отдела безопасности» и «Кадрового админа».
 * Каталог и валидация режимов — настоящие: ключ только на просмотр.
 */

const { pgQueryOne, pgExecute } = vi.hoisted(() => ({
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

vi.mock('../services/access-control.service.js', async () => {
  const { DEFAULT_ACCESS_PAGE_CATALOG } = await vi.importActual<typeof import('../config/access-control.js')>(
    '../config/access-control.js',
  );
  return {
    invalidateRoleListCache: vi.fn(),
    invalidateRolePageAccessCache: vi.fn(),
    invalidatePageCatalogCache: vi.fn(),
    loadAccessPageCatalog: vi.fn(async () => DEFAULT_ACCESS_PAGE_CATALOG),
  };
});
vi.mock('../services/correction-restrictions.service.js', () => ({ invalidateCorrectionRestrictionsCache: vi.fn() }));
vi.mock('../services/critical-admin-access.service.js', () => ({ ensureCriticalAdminAccess: vi.fn(async () => undefined) }));
vi.mock('../services/assignable-roles.service.js', () => ({ isRoleAssignableByNonAdmin: vi.fn(async () => true) }));
vi.mock('../services/scope-cache.service.js', () => ({
  invalidateGlobalReadScopeCaches: vi.fn(),
  invalidateDepartmentScopeCaches: vi.fn(),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));

import { rolesController } from './roles.controller.js';

const DIRECTORY = '/skud-settings/directory';

const makeReq = (code: string, pageAccess: Record<string, string>): AuthenticatedRequest => ({
  params: { code },
  body: { page_access: pageAccess },
  user: { id: 'admin-1', role_code: 'admin', is_admin: true },
}) as unknown as AuthenticatedRequest;

const makeRes = () => {
  const res = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.payload = body; return this; },
  };
  return res as Response & { statusCode: number; payload: unknown };
};

/** Профиль доступа, ушедший в replace_role_access_profile. */
const savedProfile = (): Array<{ key: string; mode: string }> => {
  const call = pgExecute.mock.calls.find(([sql]) => String(sql).includes('replace_role_access_profile'));
  return call ? JSON.parse(String((call[1] as unknown[])[2])) : [];
};

beforeEach(() => {
  pgExecute.mockReset().mockResolvedValue(undefined);
  pgQueryOne.mockReset().mockImplementation(async (_sql: string, params: unknown[] = []) => ({
    id: `role-${String(params[0])}`,
    code: params[0],
    is_admin: false,
    admin_access: true,
    is_active: true,
  }));
});

describe.each(['security', 'hr_admin'])('матрица роли %s: ключ просмотра справочников СКУД', (code) => {
  it('«Просмотр» сохраняется строкой профиля', async () => {
    const res = makeRes();
    await rolesController.updateAccessProfile(makeReq(code, { '/sigur': 'edit', [DIRECTORY]: 'view' }), res);
    expect(res.statusCode).toBe(200);
    expect(savedProfile()).toContainEqual({ key: DIRECTORY, mode: 'view' });
  });

  it('«Нет доступа» снимает ключ: в профиле его нет', async () => {
    const res = makeRes();
    await rolesController.updateAccessProfile(makeReq(code, { '/sigur': 'edit', [DIRECTORY]: 'none' }), res);
    expect(res.statusCode).toBe(200);
    expect(savedProfile().some(entry => entry.key === DIRECTORY && entry.mode !== 'none')).toBe(false);
  });

  it('«Изменение» для ключа только на просмотр → 400, ничего не пишем', async () => {
    const res = makeRes();
    await rolesController.updateAccessProfile(makeReq(code, { [DIRECTORY]: 'edit' }), res);
    expect(res.statusCode).toBe(400);
    expect(pgExecute).not.toHaveBeenCalled();
  });
});

describe('роль без «Доступа в админку»', () => {
  it('ключ админки не сохраняется, даже если прислан', async () => {
    pgQueryOne.mockImplementation(async (_sql: string, params: unknown[] = []) => ({
      id: 'role-office', code: params[0], is_admin: false, admin_access: false, is_active: true,
    }));
    const res = makeRes();
    await rolesController.updateAccessProfile(makeReq('office', { [DIRECTORY]: 'view' }), res);
    expect(res.statusCode).toBe(200);
    expect(savedProfile().some(entry => entry.key === DIRECTORY)).toBe(false);
  });
});
