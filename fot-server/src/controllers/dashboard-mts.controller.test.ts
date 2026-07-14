import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

// Вкладка «МТС» на «Обзоре»: граница отдела и отсутствие ПДн/денег в ответе.
// parseUsagePeriod НЕ мокаем — период считает реальная функция (общая с админкой).

vi.mock('../services/data-scope.service.js', () => ({
  resolveScopedDepartmentId: vi.fn(async () => null),
  hasObjectViewScope: vi.fn(async () => false),
  resolveAccessibleEmployeeIds: vi.fn(async () => 'all'),
}));
vi.mock('../services/skud-shared.service.js', () => ({
  collectDeptIds: vi.fn(async (id: string) => [id, 'child-dept']),
}));
vi.mock('../services/mts-business-dept-usage.service.js', () => ({
  mtsBusinessDeptUsageService: {
    getDepartmentUsageByEmployee: vi.fn(async () => ({
      totals: [{ key: 'calls', count: 2, seconds: 60, bytes: 0, inCount: 1, inSeconds: 30, outCount: 1, outSeconds: 30 }],
      employees: [{ employeeId: 7, fullName: 'Иванов Иван', tabNumber: '0042', groups: [] }],
      employeesWithSim: 3,
      syncedAt: '2026-07-14T03:12:44.000Z',
    })),
  },
}));

import { dashboardMtsController } from './dashboard-mts.controller.js';
import {
  resolveScopedDepartmentId,
  hasObjectViewScope,
  resolveAccessibleEmployeeIds,
} from '../services/data-scope.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';
import { mtsBusinessDeptUsageService } from '../services/mts-business-dept-usage.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const scope = vi.mocked({ resolveScopedDepartmentId, hasObjectViewScope, resolveAccessibleEmployeeIds });
const deptIds = vi.mocked(collectDeptIds);
const usage = vi.mocked(mtsBusinessDeptUsageService);

const DEPT = 'd1b2c3d4-0000-0000-0000-000000000001';

const mockReq = (query: Record<string, unknown>): AuthenticatedRequest =>
  ({ user: { id: 'u-1', employee_id: 1 }, query, body: {}, params: {} } as unknown as AuthenticatedRequest);

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
};

describe('Дашборд «МТС»: статистика по отделу руководителя', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope.resolveScopedDepartmentId.mockResolvedValue(DEPT);
    scope.hasObjectViewScope.mockResolvedValue(false);
    scope.resolveAccessibleEmployeeIds.mockResolvedValue('all');
    deptIds.mockResolvedValue([DEPT, 'child-dept']);
  });

  it('чужой отдел → 403 DEPARTMENT_ACCESS_DENIED, БД не трогаем', async () => {
    scope.resolveScopedDepartmentId.mockResolvedValue(null);
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'DEPARTMENT_ACCESS_DENIED' }));
    expect(usage.getDepartmentUsageByEmployee).not.toHaveBeenCalled();
  });

  it('отдел не выбран и скоуп пуст → 400', async () => {
    scope.resolveScopedDepartmentId.mockResolvedValue(null);
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({}), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(usage.getDepartmentUsageByEmployee).not.toHaveBeenCalled();
  });

  it('битый month → 400 (до похода в БД)', async () => {
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: 'июль' }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(usage.getDepartmentUsageByEmployee).not.toHaveBeenCalled();
  });

  it('без month → период = текущий месяц', async () => {
    const res = mockRes();
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT }), res);

    const [, dateFrom, dateTo] = usage.getDepartmentUsageByEmployee.mock.calls[0];
    expect(dateFrom).toBe(`${ym}-01`);
    expect(dateTo.startsWith(ym)).toBe(true);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('високосный февраль → dateTo = 29 число', async () => {
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: '2028-02' }), res);

    const [, dateFrom, dateTo] = usage.getDepartmentUsageByEmployee.mock.calls[0];
    expect(dateFrom).toBe('2028-02-01');
    expect(dateTo).toBe('2028-02-29');
  });

  it('считает по поддереву отдела, а не только по выбранному узлу', async () => {
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: '2026-07' }), res);

    expect(deptIds).toHaveBeenCalledWith(DEPT);
    const [passedDeptIds] = usage.getDepartmentUsageByEmployee.mock.calls[0];
    expect(passedDeptIds).toEqual([DEPT, 'child-dept']);
  });

  it('объектный view-скоуп → в сервис уходит список разрешённых сотрудников', async () => {
    scope.hasObjectViewScope.mockResolvedValue(true);
    scope.resolveAccessibleEmployeeIds.mockResolvedValue(new Set([7, 9]));
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: '2026-07' }), res);

    const [, , , allowed] = usage.getDepartmentUsageByEmployee.mock.calls[0];
    expect(allowed).toEqual([7, 9]);
  });

  it('без объектного скоупа сужения нет (allowedEmployeeIds = null)', async () => {
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: '2026-07' }), res);

    const [, , , allowed] = usage.getDepartmentUsageByEmployee.mock.calls[0];
    expect(allowed).toBeNull();
  });

  it('ПДн-регресс: в ответе нет номеров, собеседников и денег', async () => {
    const res = mockRes();

    await dashboardMtsController.getDepartmentMtsUsage(mockReq({ department_id: DEPT, month: '2026-07' }), res);

    const payload = JSON.stringify(res.json.mock.calls[0][0]);
    expect(payload).not.toMatch(/msisdn/i);
    expect(payload).not.toMatch(/peer/i);
    expect(payload).not.toMatch(/amount/i);
  });
});
