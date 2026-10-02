import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * GET /roles отдаёт assignable, как /roles/labels: селектор роли в «Пользователях»
 * кадровому админу показывает только роли из allowlist (иначе смена роли — 403).
 */

const { pgQuery, assignableMock } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  assignableMock: vi.fn(async (code: string | null | undefined) => code === 'office' || code === 'worker'),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../services/assignable-roles.service.js', () => ({
  isRoleAssignableByNonAdmin: assignableMock,
}));
vi.mock('../services/access-control.service.js', () => ({
  invalidateRoleListCache: vi.fn(),
  invalidateRolePageAccessCache: vi.fn(),
}));
vi.mock('../services/correction-restrictions.service.js', () => ({
  invalidateCorrectionRestrictionsCache: vi.fn(),
}));
vi.mock('../services/access-catalog.service.js', () => ({
  loadAccessCatalog: vi.fn(async () => []),
  normalizeKnownPageAccessModes: vi.fn((modes: Record<string, string>) => modes),
  pageAccessRowsToModes: vi.fn(() => ({})),
  validatePageAccessModes: vi.fn(async () => null),
}));
vi.mock('../services/critical-admin-access.service.js', () => ({
  ensureCriticalAdminAccess: vi.fn(async () => undefined),
}));
vi.mock('../services/scope-cache.service.js', () => ({
  invalidateGlobalReadScopeCaches: vi.fn(),
  invalidateDepartmentScopeCaches: vi.fn(),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));

import { rolesController } from './roles.controller.js';

function makeRes(): Response & { _status: number; _json: unknown } {
  const res = { _status: 200, _json: null } as Response & { _status: number; _json: unknown };
  res.status = vi.fn((s: number) => { res._status = s; return res; }) as unknown as Response['status'];
  res.json = vi.fn((j: unknown) => { res._json = j; return res; }) as unknown as Response['json'];
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rolesController.getRoles', () => {
  it('каждая роль несёт assignable по allowlist', async () => {
    pgQuery.mockResolvedValue([
      { id: 'r1', code: 'admin', name: 'Администратор', is_admin: true },
      { id: 'r2', code: 'hr_admin', name: 'Кадровый админ', is_admin: false },
      { id: 'r3', code: 'office', name: 'Офисный сотрудник', is_admin: false },
    ]);
    const res = makeRes();

    await rolesController.getRoles({} as AuthenticatedRequest, res);

    expect(res._json).toEqual({
      success: true,
      data: [
        { id: 'r1', code: 'admin', name: 'Администратор', is_admin: true, assignable: false },
        { id: 'r2', code: 'hr_admin', name: 'Кадровый админ', is_admin: false, assignable: false },
        { id: 'r3', code: 'office', name: 'Офисный сотрудник', is_admin: false, assignable: true },
      ],
    });
  });
});
