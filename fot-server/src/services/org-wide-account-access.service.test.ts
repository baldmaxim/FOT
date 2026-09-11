import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveEffectivePageAccess: vi.fn(),
  resolveCompanyScope: vi.fn(),
}));

vi.mock('./access-control.service.js', () => ({
  resolveEffectivePageAccess: h.resolveEffectivePageAccess,
}));
vi.mock('./data-scope.service.js', () => ({
  resolveCompanyScope: h.resolveCompanyScope,
}));

import { hasOrgWideAccountAccess } from './org-wide-account-access.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const makeReq = (user: Record<string, unknown>): AuthenticatedRequest => ({
  user: { id: 'u1', role_code: 'security', is_admin: false, ...user },
}) as unknown as AuthenticatedRequest;

beforeEach(() => {
  h.resolveEffectivePageAccess.mockReset();
  h.resolveCompanyScope.mockReset();
});

describe('hasOrgWideAccountAccess', () => {
  it('системный админ — да, без проверки ключа', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    expect(await hasOrgWideAccountAccess(makeReq({ is_admin: true, role_code: 'admin' }), 'edit')).toBe(true);
    expect(h.resolveEffectivePageAccess).not.toHaveBeenCalled();
  });

  it('админ компании — нет: page-access он обходит, поэтому ключ не спрашиваем', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['root-1'] });
    expect(await hasOrgWideAccountAccess(makeReq({ is_admin: true, role_code: 'admin' }), 'edit')).toBe(false);
    expect(h.resolveEffectivePageAccess).not.toHaveBeenCalled();
  });

  it('не-админ — решает ключ /admin/users/accounts с запрошенным действием', async () => {
    h.resolveEffectivePageAccess.mockResolvedValue(true);
    expect(await hasOrgWideAccountAccess(makeReq({}), 'view')).toBe(true);
    expect(h.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/admin/users/accounts', 'view');
  });

  it('не-админ без ключа — нет', async () => {
    h.resolveEffectivePageAccess.mockResolvedValue(false);
    expect(await hasOrgWideAccountAccess(makeReq({}), 'edit')).toBe(false);
  });
});
