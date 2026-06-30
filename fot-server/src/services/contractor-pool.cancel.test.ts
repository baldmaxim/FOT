import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Моки БД и Sigur ---
const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
}));

const sig = vi.hoisted(() => ({
  getBackgroundConnectionType: vi.fn(async () => 'external'),
  deleteEmployee: vi.fn(async () => undefined),
  delEmp: vi.fn(async () => undefined),
  isDryRun: vi.fn(() => false),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: sig.getBackgroundConnectionType,
    deleteEmployee: sig.deleteEmployee,
    getEmployees: vi.fn(async () => []),
  },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({
  createSigurEmployee: vi.fn(async () => ({ sigurEmployeeId: 1 })),
  deleteSigurEmployee: sig.delEmp,
  moveSigurEmployee: vi.fn(async () => undefined),
  updateSigurEmployee: vi.fn(async () => undefined),
}));
vi.mock('./sigur-live-cards.service.js', () => ({
  assignSigurEmployeeCardBinding: vi.fn(async () => ({ card: { cardId: 10 } })),
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: sig.isDryRun,
}));
vi.mock('./contractor-scope.service.js', () => ({
  getOrgSigurDepartmentId: vi.fn(async () => 555),
  ContractorScopeError: class ContractorScopeError extends Error { status = 403; },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { get: vi.fn(async () => '999'), set: vi.fn(async () => undefined) },
}));

import { cancelProvisioningFailedPasses } from './contractor-pool.service.js';

describe('cancelProvisioningFailedPasses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sig.isDryRun.mockReturnValue(false);
  });

  it('удаляет provisioning_failed строку + чистит placeholder-профиль в Sigur', async () => {
    pgQuery.mockResolvedValue([
      { id: 'row-3886', pass_number: '3886', sigur_employee_id: 148180 },
    ]);
    pgExecute.mockResolvedValue(1);

    const res = await cancelProvisioningFailedPasses(['3886']);

    expect(res.cancelled).toEqual(['3886']);
    expect(res.failed).toEqual([]);
    // Удалён именно профиль этого пропуска (не соседа-дубля).
    expect(sig.delEmp).toHaveBeenCalledWith(148180, 'external');
    // DELETE с гардом по статусу/пулу.
    const delSql = String(pgExecute.mock.calls[0][0]);
    expect(delSql).toContain('DELETE FROM contractor_passes');
    expect(delSql).toContain("status IN ('provisioning', 'provisioning_failed')");
    expect(delSql).toContain('org_department_id IS NULL');
  });

  it('гард: DELETE не затронул строку (0 rows) → номер в failed, не в cancelled', async () => {
    pgQuery.mockResolvedValue([
      { id: 'row-3886', pass_number: '3886', sigur_employee_id: 148180 },
    ]);
    pgExecute.mockResolvedValue(0);

    const res = await cancelProvisioningFailedPasses(['3886']);

    expect(res.cancelled).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].pass_number).toBe('3886');
  });

  it('сбой Sigur-очистки (404) не мешает удалить строку', async () => {
    pgQuery.mockResolvedValue([
      { id: 'row-3886', pass_number: '3886', sigur_employee_id: 148180 },
    ]);
    pgExecute.mockResolvedValue(1);
    sig.delEmp.mockRejectedValueOnce(new Error('404 not found'));

    const res = await cancelProvisioningFailedPasses(['3886']);

    expect(res.cancelled).toEqual(['3886']);
  });

  it('dryRun: профиль в Sigur не трогаем, строку удаляем', async () => {
    sig.isDryRun.mockReturnValue(true);
    pgQuery.mockResolvedValue([
      { id: 'row-3886', pass_number: '3886', sigur_employee_id: 148180 },
    ]);
    pgExecute.mockResolvedValue(1);

    const res = await cancelProvisioningFailedPasses(['3886']);

    expect(res.cancelled).toEqual(['3886']);
    expect(sig.delEmp).not.toHaveBeenCalled();
  });

  it('пустой ввод — no-op без обращения к БД', async () => {
    const res = await cancelProvisioningFailedPasses([]);
    expect(res).toEqual({ cancelled: [], failed: [] });
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
