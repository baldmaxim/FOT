import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ query: pgQuery }));

const { listDepartmentManagers, DEPARTMENT_MANAGER_CONDITION_SQL } =
  await import('./department-managers.service.js');

const DEPT = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd';

beforeEach(() => {
  vi.clearAllMocks();
  pgQuery.mockResolvedValue([]);
});

describe('listDepartmentManagers', () => {
  it('пустой список отделов — в БД не ходим', async () => {
    const result = await listDepartmentManagers([]);
    expect(result.size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('условие отбора включает все три фильтра', async () => {
    // source <> sigur_sync критичен: синк СКУД пишет туда обычное членство, и без
    // фильтра начальником своего отдела стал бы каждый рядовой сотрудник.
    expect(DEPARTMENT_MANAGER_CONDITION_SQL).toContain('is_active = true');
    expect(DEPARTMENT_MANAGER_CONDITION_SQL).toContain("access_level = 'full'");
    expect(DEPARTMENT_MANAGER_CONDITION_SQL).toContain("source <> 'sigur_sync'");

    await listDepartmentManagers([DEPT]);
    expect(String(pgQuery.mock.calls[0]![0])).toContain(DEPARTMENT_MANAGER_CONDITION_SQL);
  });

  it('группирует руководителей по отделу', async () => {
    pgQuery.mockResolvedValue([
      { employee_id: 501, department_id: DEPT },
      { employee_id: 502, department_id: DEPT },
    ]);

    const result = await listDepartmentManagers([DEPT]);
    expect(result.get(DEPT)).toEqual([501, 502]);
  });

  it('отдел без назначений ключа не получает — отсутствие = руководителя нет', async () => {
    pgQuery.mockResolvedValue([]);
    const result = await listDepartmentManagers([DEPT]);
    expect(result.has(DEPT)).toBe(false);
  });

  it('exec заменяет пул: снимок читается из транзакции', async () => {
    const exec = { query: vi.fn().mockResolvedValue({ rows: [{ employee_id: 501, department_id: DEPT }] }) };
    const result = await listDepartmentManagers([DEPT], exec as never);

    expect(result.get(DEPT)).toEqual([501]);
    expect(exec.query).toHaveBeenCalled();
    expect(pgQuery).not.toHaveBeenCalled();
  });
});
