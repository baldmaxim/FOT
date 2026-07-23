import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  resolveCompanyScope: vi.fn(),
  hasPageView: vi.fn(),
  hasPageEdit: vi.fn(),
  getContractorRootId: vi.fn(),
}));

vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: h.hasPageView,
  hasPageEdit: h.hasPageEdit,
}));
vi.mock('../config/contractor.js', () => ({ getContractorRootId: h.getContractorRootId }));

const CONTRACTOR_ROOT = 'contractor-root';

import {
  CONTRACTOR_SECTION_PAGE_KEY,
  SUBMISSIONS_PAGE_KEY,
  OTITB_PAGE_KEY,
  ensureContractorSectionAccess,
  ensureOtitbAccess,
  ensureSubmissionsAccess,
} from './contractor-access-gate.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return res; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; return res; }),
  };
  return res;
};

const makeReq = (isAdmin: boolean, roleCode = 'security') =>
  ({ user: { id: 'u-1', role_code: roleCode, is_admin: isAdmin } }) as never;

/** Гранты по ключам страниц: всё остальное — запрещено. */
const grantKeys = (keys: string[], action: 'view' | 'edit' = 'edit') => {
  h.hasPageView.mockImplementation(async (_role: string, key: string) => keys.includes(key));
  h.hasPageEdit.mockImplementation(
    async (_role: string, key: string) => action === 'edit' && keys.includes(key),
  );
};

const GATES = {
  section: ensureContractorSectionAccess,
  submissions: ensureSubmissionsAccess,
  otitb: ensureOtitbAccess,
};

/** Прогоняет три гейта и возвращает карту «пропущен ли». */
const runAll = async (req: never, action: 'view' | 'edit' = 'view') => {
  const out: Record<string, boolean> = {};
  for (const [name, gate] of Object.entries(GATES)) {
    out[name] = await gate(req, makeRes() as never, action);
  }
  return out;
};

describe('contractor-access-gate', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
  });

  it('системный админ проходит все гейты, гранты не запрашиваются', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    expect(await runAll(makeReq(true, 'admin'))).toEqual({
      section: true, submissions: true, otitb: true,
    });
    expect(h.hasPageView).not.toHaveBeenCalled();
    expect(h.hasPageEdit).not.toHaveBeenCalled();
    // roots==='all' возвращает раньше — корень подрядчиков не запрашивается.
    expect(h.getContractorRootId).not.toHaveBeenCalled();
  });

  it('роль с основным грантом (security) проходит все три гейта на view и edit', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([CONTRACTOR_SECTION_PAGE_KEY]);
    expect(await runAll(makeReq(false), 'view')).toEqual({
      section: true, submissions: true, otitb: true,
    });
    expect(await runAll(makeReq(false), 'edit')).toEqual({
      section: true, submissions: true, otitb: true,
    });
    // Не-админ уходит в else-ветку — корень подрядчиков не запрашивается.
    expect(h.getContractorRootId).not.toHaveBeenCalled();
  });

  it('грант только на /submissions открывает лишь вкладку заявок', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SUBMISSIONS_PAGE_KEY]);
    expect(await runAll(makeReq(false))).toEqual({
      section: false, submissions: true, otitb: false,
    });
  });

  it('грант только на /otitb открывает лишь вкладку ОТиТБ', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([OTITB_PAGE_KEY]);
    expect(await runAll(makeReq(false))).toEqual({
      section: false, submissions: false, otitb: true,
    });
  });

  it('узкая роль ОТиТБ (оба технических ключа) не получает раздел целиком', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([SUBMISSIONS_PAGE_KEY, OTITB_PAGE_KEY]);
    expect(await runAll(makeReq(false, 'otitb'))).toEqual({
      section: false, submissions: true, otitb: true,
    });
  });

  it('компанийный админ корня подрядчиков проходит все три гейта (view и edit)', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [CONTRACTOR_ROOT] });
    h.getContractorRootId.mockResolvedValue(CONTRACTOR_ROOT);
    expect(await runAll(makeReq(true, 'admin'), 'view')).toEqual({
      section: true, submissions: true, otitb: true,
    });
    expect(await runAll(makeReq(true, 'admin'), 'edit')).toEqual({
      section: true, submissions: true, otitb: true,
    });
    // Доступ по скоупу, а не по гранту роли.
    expect(h.hasPageView).not.toHaveBeenCalled();
    expect(h.hasPageEdit).not.toHaveBeenCalled();
  });

  it('компанийный админ, чей скоуп содержит корень подрядчиков среди нескольких, проходит', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['su10-root', CONTRACTOR_ROOT] });
    h.getContractorRootId.mockResolvedValue(CONTRACTOR_ROOT);
    expect(await runAll(makeReq(true, 'admin'))).toEqual({
      section: true, submissions: true, otitb: true,
    });
  });

  it('компанийный админ другого корня не проходит даже при гранте роли', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['su10-root'] });
    h.getContractorRootId.mockResolvedValue(CONTRACTOR_ROOT);
    grantKeys([CONTRACTOR_SECTION_PAGE_KEY, SUBMISSIONS_PAGE_KEY, OTITB_PAGE_KEY]);
    expect(await runAll(makeReq(true, 'admin'))).toEqual({
      section: false, submissions: false, otitb: false,
    });
    // Для is_admin гранты роли не проверяются.
    expect(h.hasPageView).not.toHaveBeenCalled();
  });

  it('корень подрядчиков не синхронизирован (getContractorRootId → null): 403', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['su10-root'] });
    h.getContractorRootId.mockResolvedValue(null);
    expect(await runAll(makeReq(true, 'admin'))).toEqual({
      section: false, submissions: false, otitb: false,
    });
  });

  it('роль без грантов получает 403 с «Недостаточно прав»', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([]);
    const res = makeRes();
    expect(await ensureContractorSectionAccess(makeReq(false), res as never, 'view')).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'Недостаточно прав' });
  });

  it('грант только на просмотр не даёт edit', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: [] });
    grantKeys([CONTRACTOR_SECTION_PAGE_KEY], 'view');
    expect(await runAll(makeReq(false), 'view')).toEqual({
      section: true, submissions: true, otitb: true,
    });
    expect(await runAll(makeReq(false), 'edit')).toEqual({
      section: false, submissions: false, otitb: false,
    });
  });
});
