import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * МТС → «Связанные сотрудники»: доступ — пакетно и до страницы и total; поиск ФИО — точно, а если среди
 * доступных точных нет — с одной ошибкой (точный у недоступного опечатку не глушит).
 */

const { h } = vi.hoisted(() => ({
  h: {
    pgQuery: vi.fn(),
    filterScope: vi.fn(async (_req: unknown, ids: number[]) => ids),
    canAccess: vi.fn(async () => true),
  },
}));

vi.mock('../config/postgres.js', () => ({ query: h.pgQuery }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccess,
  canWriteEmployeeInScope: vi.fn(async () => true),
  filterEmployeeIdsInScope: h.filterScope,
}));
vi.mock('../services/encryption.service.js', () => ({
  encryptionService: { decryptField: (value: string | null) => (value ? `dec:${value}` : null) },
}));
vi.mock('../services/settings.service.js', () => ({ settingsService: {} }));
vi.mock('../services/mts-data.service.js', () => ({ mtsDataService: {} }));
vi.mock('../services/mts-mapping.service.js', () => ({ mtsMappingService: {} }));
vi.mock('../services/mts-tasks.service.js', () => ({ mtsTasksService: {} }));
vi.mock('../services/mts-base.service.js', () => ({ MtsApiError: class extends Error {} }));
vi.mock('../services/audit.service.js', () => ({ auditService: {}, AUDIT_ACTIONS: {} }));
vi.mock('../services/mts-geofence.service.js', () => ({ mtsGeofenceService: {}, GeofenceValidationError: class extends Error {} }));

const { mtsController } = await import('./mts.controller.js');

const linked = (subscriber_id: number, employee_id: number, employee_full_name: string) => ({
  subscriber_id, employee_id, employee_full_name, employee_tab_number: null,
  phone_enc: `p${subscriber_id}`, display_name_enc: null, last_recorded_at: null,
});

const call = async (query: Record<string, string>, isAdmin = false) => {
  const res = {
    body: null as unknown as { data: Array<{ employeeId: number; phone: string }>; meta: { total: number } },
    status() { return res; },
    json(body: unknown) { res.body = body as typeof res.body; return res; },
  };
  await mtsController.getEmployeesLinked(
    { query, user: { id: 'u', is_admin: isAdmin, role_code: 'manager' }, method: 'GET', path: '/x' } as unknown as AuthenticatedRequest,
    res as unknown as Response,
  );
  return res.body;
};

beforeEach(() => {
  h.pgQuery.mockReset();
  h.filterScope.mockReset().mockImplementation(async (_req, ids) => ids);
  h.canAccess.mockReset();
});

describe('mtsController.getEmployeesLinked', () => {
  it('доступ — пакетно до страницы: total считает только доступных, поштучных проверок нет', async () => {
    h.pgQuery.mockResolvedValue([linked(1, 11, 'Абаев'), linked(2, 12, 'Бабаев'), linked(3, 13, 'Вагин')]);
    h.filterScope.mockImplementation(async (_req, ids) => ids.filter(id => id !== 12));
    const body = await call({ page: '1', pageSize: '1' });
    expect(body.meta.total).toBe(2);
    expect(body.data.map(row => row.employeeId)).toEqual([11]);
    expect(body.data[0].phone).toBe('dec:p1');
    expect(h.canAccess).not.toHaveBeenCalled();
    // Без LIMIT/OFFSET в SQL: страница — после доступа.
    expect(String(h.pgQuery.mock.calls[0][0])).not.toMatch(/LIMIT|OFFSET/);
  });

  it('админ — без фильтра доступа', async () => {
    h.pgQuery.mockResolvedValue([linked(1, 11, 'Абаев')]);
    await call({}, true);
    expect(h.filterScope).not.toHaveBeenCalled();
  });

  it('точный только у недоступного — среди доступных ищется с одной ошибкой', async () => {
    h.pgQuery.mockImplementation(async (sql: string) => (String(sql).includes('unnest(')
      ? [linked(1, 11, 'Гринёв Андрей'), linked(2, 12, 'Гринав Олег')]
      : [linked(1, 11, 'Гринёв Андрей')]));
    h.filterScope.mockImplementation(async (_req, ids) => ids.filter(id => id === 12));
    const body = await call({ search: 'гринев' });
    expect(body.data.map(row => row.employeeId)).toEqual([12]);
    const exactSql = String(h.pgQuery.mock.calls[0][0]);
    expect(exactSql).toContain('(e.full_name ~* $1)');
    expect(h.pgQuery.mock.calls[0][1]).toEqual(['грин[её]в']);
  });

  it('точный доступный есть — опечаток нет', async () => {
    h.pgQuery.mockResolvedValue([linked(1, 11, 'Гринёв Андрей')]);
    const body = await call({ search: 'гринев' });
    expect(body.data.map(row => row.employeeId)).toEqual([11]);
    expect(h.pgQuery).toHaveBeenCalledTimes(1);
  });
});
