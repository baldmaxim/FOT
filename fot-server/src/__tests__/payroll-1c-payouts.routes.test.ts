import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

/**
 * Ведомости выплаты из 1С (миграция 328): загрузка — только при правке «Расчётов» и всём штате «Зарплаты».
 * Права и приём файла настоящие (resolveEffectivePageAccess, canImportPayouts1c, multer), сервис — заглушка.
 * Без права — 403 ДО приёма файла (большой файл не даёт 413); кнопка (capability) и API решаются одной функцией.
 */

const h = vi.hoisted(() => ({
  listedUserIds: new Set<string>(),
  scope: 'all' as string[] | 'all',
  previews: [] as number[],
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: vi.fn().mockResolvedValue({ token_version: 0 }),
  query: vi.fn(async (sql: string, params: unknown[] = []) => (
    String(sql).includes('FROM payroll_section_access') && h.listedUserIds.has(String(params[0]))
      ? [{ user_id: params[0] }]
      : []
  )),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('../services/roles-cache.service.js', () => ({
  getRoleByCode: vi.fn(async (code: string) => ({
    id: `role-${code}`, code, is_admin: code === 'admin', admin_access: code !== 'office', manager_auto_access: true, is_active: true,
  })),
  getRoleById: vi.fn(async () => null),
  invalidateRolesCache: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleDepartmentIds: vi.fn(async () => h.scope),
  hasAllDepartmentsScope: vi.fn(async () => false),
  hasDeputyAssignment: vi.fn(async () => false),
  canAccessEmployeeInScope: vi.fn(async () => true),
  canEditEmployeeInScope: vi.fn(async () => true),
  resolveEditableEmployeeIds: vi.fn(async () => []),
}));
vi.mock('../services/hiring-access.service.js', () => ({
  hasHiringAutoAccess: vi.fn(async () => false),
  isHiringRequesterRole: vi.fn(() => false),
}));
vi.mock('../services/object-kpi-roles-cache.service.js', () => ({ isEconomicsHead: vi.fn(async () => false) }));
vi.mock('../services/payroll/payroll-1c-payouts.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/payroll/payroll-1c-payouts.service.js')>()),
  previewPayouts1c: vi.fn(async (buffer: Buffer) => {
    h.previews.push(buffer.length);
    return { status: 'new' };
  }),
}));

const app = express();
app.use(express.json());
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);
const { invalidateRolePageAccessCache } = await import('../services/access-control.service.js');

const tokenFor = (userId: string, roleCode: string): string => jwt.sign(
  {
    sub: userId,
    email: `${userId}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: roleCode === 'admin',
    employee_variant: 'office',
    employee_id: 577,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const XML = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><ЗУП_ВЫПЛАТЫ/>', 'utf8');
const BIG = Buffer.alloc(6 * 1024 * 1024, 0x20);

const capability = (userId: string, role: string) => request(app)
  .get('/api/payroll/1c-payouts/capability').set('Authorization', `Bearer ${tokenFor(userId, role)}`);
const upload = (userId: string, role: string, file: Buffer, name = 'ведомость.xml') => request(app)
  .post('/api/payroll/1c-payouts/preview')
  .set('Authorization', `Bearer ${tokenFor(userId, role)}`)
  .attach('file', file, name);

beforeEach(() => {
  h.listedUserIds.clear();
  h.scope = 'all';
  h.previews.length = 0;
  invalidateRolePageAccessCache();
});

describe('ведомости выплаты из 1С: права и приём файла', () => {
  it('не из списка «Зарплаты» — 403 и на кнопку, и на загрузку, даже большого файла', async () => {
    expect((await capability('outside', 'office')).status).toBe(403);
    expect((await upload('outside', 'office', BIG)).status).toBe(403);
    expect(h.previews).toEqual([]);
  });

  it('из списка с частичным охватом (админ компании) — кнопки нет, загрузка 403 до приёма файла', async () => {
    h.listedUserIds.add('company-admin');
    h.scope = ['dep-1'];
    const cap = await capability('company-admin', 'admin');
    expect(cap.status).toBe(200);
    expect(cap.body.data).toEqual({ can_import: false });
    expect((await upload('company-admin', 'admin', BIG)).status).toBe(403);
    expect(h.previews).toEqual([]);
  });

  it('из списка со всем штатом — кнопка есть; больше 5 МБ — 413, не .xml — 400, .xml — предпросмотр', async () => {
    h.listedUserIds.add('buh');
    const cap = await capability('buh', 'office');
    expect(cap.body.data).toEqual({ can_import: true });
    expect((await upload('buh', 'office', BIG)).status).toBe(413);
    expect((await upload('buh', 'office', XML, 'ведомость.xlsx')).status).toBe(400);
    const ok = await upload('buh', 'office', XML);
    expect(ok.status).toBe(200);
    expect(h.previews).toEqual([XML.length]);
  });
});
