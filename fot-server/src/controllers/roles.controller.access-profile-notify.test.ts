import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Сохранение матрицы роли (PUT /api/roles/:code/access-profile) обязано разбудить открытые
 * сессии пользователей этой роли — иначе новые права появятся только после перезахода.
 * Порядок принципиален: клиент по событию сразу тянет /auth/me, и если кеш прав ещё не
 * сброшен, он получит старую матрицу.
 */

const { order, pgQuery, pgQueryOne, pgExecute } = vi.hoisted(() => ({
  order: [] as string[],
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

vi.mock('../services/access-control.service.js', async () => {
  const { DEFAULT_ACCESS_PAGE_CATALOG } = await vi.importActual<typeof import('../config/access-control.js')>(
    '../config/access-control.js',
  );
  return {
    invalidateRoleListCache: vi.fn(() => { order.push('invalidate:role-list'); }),
    invalidateRolePageAccessCache: vi.fn(() => { order.push('invalidate:page-access'); }),
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
vi.mock('../socket/io-instance.js', () => ({
  getIo: vi.fn(() => ({
    to: (room: string) => ({
      emit: (event: string) => { order.push(`emit:${room}:${event}`); },
    }),
  })),
}));

import { rolesController } from './roles.controller.js';

const makeReq = (pageAccess: Record<string, string>): AuthenticatedRequest => ({
  params: { code: 'timekeeper' },
  body: { page_access: pageAccess },
  user: { id: 'admin-1', role_code: 'admin', is_admin: true },
}) as unknown as AuthenticatedRequest;

const makeRes = () => {
  const res = {
    statusCode: 200,
    payload: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { order.push('response'); this.payload = body; return this; },
  };
  return res as Response & { statusCode: number; payload: unknown };
};

beforeEach(() => {
  order.length = 0;
  pgExecute.mockReset().mockImplementation(async (sql: string) => {
    if (String(sql).includes('replace_role_access_profile')) order.push('persist');
  });
  pgQueryOne.mockReset().mockResolvedValue({
    id: 'role-timekeeper', code: 'timekeeper', is_admin: false, admin_access: true, is_active: true,
  });
  pgQuery.mockReset().mockImplementation(async (sql: string, params: unknown[] = []) => (
    String(sql).includes('FROM user_profiles WHERE system_role_id') && params[0] === 'role-timekeeper'
      ? [{ id: 'user-a' }, { id: 'user-b' }]
      : []
  ));
});

describe('updateAccessProfile: уведомление открытых сессий роли', () => {
  it('шлёт profile:access_changed каждому пользователю роли', async () => {
    const res = makeRes();
    await rolesController.updateAccessProfile(makeReq({ '/staff-control': 'view' }), res);

    expect(res.statusCode).toBe(200);
    expect(order).toContain('emit:user:user-a:profile:access_changed');
    expect(order).toContain('emit:user:user-b:profile:access_changed');
  });

  it('порядок: сохранение → сброс обоих кешей → событие → ответ', async () => {
    await rolesController.updateAccessProfile(makeReq({ '/staff-control': 'view' }), makeRes());

    expect(order).toEqual([
      'persist',
      'invalidate:role-list',
      'invalidate:page-access',
      'emit:user:user-a:profile:access_changed',
      'emit:user:user-b:profile:access_changed',
      'response',
    ]);
  });

  it('отклонённое сохранение никого не будит', async () => {
    const res = makeRes();
    // /dashboard/all-departments — ключ только на просмотр.
    await rolesController.updateAccessProfile(makeReq({ '/dashboard/all-departments': 'edit' }), res);

    expect(res.statusCode).toBe(400);
    expect(order.some(entry => entry.startsWith('emit:'))).toBe(false);
  });
});
