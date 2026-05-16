import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pgQuery, pgExecute, dryRun, getOrgSigurDeptId, listSigur, bgConn } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgExecute: vi.fn(),
  dryRun: vi.fn(),
  getOrgSigurDeptId: vi.fn(),
  listSigur: vi.fn(),
  bgConn: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: pgQuery, execute: pgExecute }));
vi.mock('../config/contractor.js', () => ({ isContractorSigurDryRun: dryRun }));
vi.mock('./contractor-scope.service.js', () => ({ getOrgSigurDepartmentId: getOrgSigurDeptId }));
vi.mock('./sigur.service.js', () => ({ sigurService: { getBackgroundConnectionType: bgConn } }));
vi.mock('./sigur-live-admin.service.js', () => ({ listSigurEmployees: listSigur }));

import { syncRosterFromSigur } from './contractor-roster.service.js';

describe('contractor-roster.service syncRosterFromSigur', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgExecute.mockReset();
    dryRun.mockReset();
    getOrgSigurDeptId.mockReset();
    listSigur.mockReset();
    bgConn.mockReset();
    bgConn.mockResolvedValue('external');
    getOrgSigurDeptId.mockResolvedValue(777);
  });

  it('dry-run: не дёргает Sigur и БД', async () => {
    dryRun.mockReturnValue(true);
    await syncRosterFromSigur('org-1');
    expect(listSigur).not.toHaveBeenCalled();
    expect(pgExecute).not.toHaveBeenCalled();
  });

  it('добавляет новых, обновляет активных, НЕ трогает pending_*', async () => {
    dryRun.mockReturnValue(false);
    // Sigur вернул: 100 (есть, pending_remove — не трогать), 200 (новый),
    // 300 (есть, active, имя изменилось — обновить).
    listSigur.mockResolvedValue({
      items: [
        { id: 100, name: 'Иванов И.' },
        { id: 200, name: 'Петров П.' },
        { id: 300, name: 'Сидоров Новый' },
      ],
      total: 3, page: 1, pageSize: 500,
    });
    pgQuery.mockResolvedValue([
      { sigur_employee_id: 100, state: 'pending_remove', full_name: 'Иванов И.' },
      { sigur_employee_id: 300, state: 'active', full_name: 'Сидоров Старый' },
    ]);
    pgExecute.mockResolvedValue(1);

    await syncRosterFromSigur('org-1');

    const sqls = pgExecute.mock.calls.map(c => String(c[0]));
    // Новый сотрудник 200 — INSERT.
    expect(sqls.some(s => s.includes('INSERT INTO contractor_roster') && pgExecute.mock.calls.some(
      c => String(c[0]).includes('INSERT INTO contractor_roster') && (c[1] as unknown[])?.includes(200),
    ))).toBe(true);
    // Активный 300 с новым именем — UPDATE.
    expect(sqls.some(s => s.includes('UPDATE contractor_roster') && s.includes("state = 'active'"))).toBe(true);
    // Ни один execute не затрагивает sigur_employee_id=100 (pending_remove).
    const touched100 = pgExecute.mock.calls.some(c => (c[1] as unknown[] | undefined)?.includes(100));
    expect(touched100).toBe(false);
  });
});
