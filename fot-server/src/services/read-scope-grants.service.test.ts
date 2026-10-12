import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * «Управление кадрами — все сотрудники»: право действует только у роли «Табельщица» и только
 * вместе с просмотром /staff-control. У остальных ролей галочка в матрице ничего не меняет —
 * их карточка и «Реквизиты» идут по общему скоупу. Администратор сюда не попадает.
 */

const h = vi.hoisted(() => ({ grants: new Set<string>() }));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (_req: unknown, page: string) => h.grants.has(page)),
}));

const { hasStaffAllEmployeesGrant } = await import('./read-scope-grants.service.js');

const req = (roleCode: string, isAdmin = false): AuthenticatedRequest =>
  ({ user: { id: 'u-1', role_code: roleCode, is_admin: isAdmin, employee_id: 577 } } as unknown as AuthenticatedRequest);

const BASE = '/staff-control';
const GRANT = '/staff-control/all-employees';

beforeEach(() => {
  h.grants.clear();
});

describe('hasStaffAllEmployeesGrant', () => {
  it('табельщица с просмотром кадров и ключом → право есть', async () => {
    h.grants.add(BASE).add(GRANT);
    expect(await hasStaffAllEmployeesGrant(req('timekeeper'))).toBe(true);
  });

  it('без ключа → права нет', async () => {
    h.grants.add(BASE);
    expect(await hasStaffAllEmployeesGrant(req('timekeeper'))).toBe(false);
  });

  it('ключ без просмотра «Управления кадрами» → права нет', async () => {
    h.grants.add(GRANT);
    expect(await hasStaffAllEmployeesGrant(req('timekeeper'))).toBe(false);
  });

  it('другая роль с тем же набором ключей → права нет', async () => {
    h.grants.add(BASE).add(GRANT);
    expect(await hasStaffAllEmployeesGrant(req('site_supervisor'))).toBe(false);
    expect(await hasStaffAllEmployeesGrant(req('security'))).toBe(false);
  });

  it('администратор сюда не попадает', async () => {
    h.grants.add(BASE).add(GRANT);
    expect(await hasStaffAllEmployeesGrant(req('timekeeper', true))).toBe(false);
  });
});
