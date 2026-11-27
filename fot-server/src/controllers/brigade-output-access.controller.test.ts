import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Вкладка «Выработка» (миграция 342): валидация, зона админа компании, аудит в транзакции, обновление профиля.
 * Вторая галочка «Ставить КТУ своим бригадам» (370): необязательное поле, только начальнику участка бригады.
 * Третья «Видеть зарплату своих сотрудников в табеле» (382): необязательное поле, только руководителю отдела.
 */

const { h } = vi.hoisted(() => ({
  h: {
    query: vi.fn(),
    queryOne: vi.fn(),
    client: { query: vi.fn() },
    canAccess: vi.fn(),
    canWrite: vi.fn(),
    load: vi.fn(),
    set: vi.fn(),
    loadKtu: vi.fn(),
    setKtu: vi.fn(),
    supervised: vi.fn(),
    loadTeam: vi.fn(),
    setTeam: vi.fn(),
    managed: vi.fn(),
    audit: vi.fn(),
    emit: vi.fn(),
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  withTransaction: async <T>(fn: (client: unknown) => Promise<T>) => fn(h.client),
}));
vi.mock('../services/audit.service.js', () => ({ auditService: { logFromRequestWithClient: h.audit } }));
vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: h.canAccess,
  canWriteEmployeeInScope: h.canWrite,
}));
vi.mock('../services/payroll/brigade-output-access.service.js', () => ({
  loadBrigadeOutputGrant: h.load,
  setBrigadeOutputGrant: h.set,
  loadSupervisorKtuGrant: h.loadKtu,
  setSupervisorKtuGrant: h.setKtu,
}));
vi.mock('../services/brigade-supervisors.service.js', () => ({ listSupervisedBrigadeIds: h.supervised }));
vi.mock('../services/payroll/team-salary-access.service.js', () => ({
  loadTeamSalaryGrant: h.loadTeam,
  setTeamSalaryGrant: h.setTeam,
  listTeamSalaryRootDepartmentNames: h.managed,
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: () => ({ to: () => ({ emit: h.emit }) }) }));

const { brigadeOutputAccessController } = await import('./brigade-output-access.controller.js');

const EMPLOYEE = 1429;

const makeReq = (id: unknown, body: unknown = {}): AuthenticatedRequest => ({
  params: { id: String(id) },
  body,
  user: { id: 'admin-user', employee_id: 1, role_code: 'admin', is_admin: true },
} as unknown as AuthenticatedRequest);

const makeRes = () => {
  const res = { statusCode: 200, body: null as unknown } as {
    statusCode: number; body: any; status: (c: number) => unknown; json: (b: unknown) => unknown;
  };
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((payload: unknown) => { res.body = payload; return res; });
  return res;
};

const put = async (body: unknown, id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await brigadeOutputAccessController.set(makeReq(id, body), res as unknown as Response);
  return res;
};

const get = async (id: unknown = EMPLOYEE) => {
  const res = makeRes();
  await brigadeOutputAccessController.get(makeReq(id), res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.queryOne.mockImplementation(async (_sql: string, params: unknown[]) => (
    params[0] === EMPLOYEE ? { id: EMPLOYEE, full_name: 'Потапов Максим Олегович' } : null
  ));
  h.query.mockResolvedValue([{ id: 'profile-potapov' }]);
  h.canAccess.mockResolvedValue(true);
  h.canWrite.mockResolvedValue(true);
  h.load.mockResolvedValue(false);
  h.set.mockResolvedValue(true);
  h.loadKtu.mockResolvedValue(false);
  h.setKtu.mockResolvedValue(true);
  h.supervised.mockResolvedValue([]);
  h.loadTeam.mockResolvedValue(false);
  h.setTeam.mockResolvedValue(true);
  h.managed.mockResolvedValue([]);
});

describe('GET /admin/employees/:id/brigade-output-access', () => {
  it('отдаёт галочку', async () => {
    h.load.mockResolvedValue(true);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({
      granted: true, supervisor_ktu: false, supervised_brigades: 0, team_salary: false, managed_departments: [],
    });
  });

  it('начальник участка: вторая галочка и число его бригад', async () => {
    h.loadKtu.mockResolvedValue(true);
    h.supervised.mockResolvedValue(['b-1', 'b-2', 'b-3']);
    expect((await get()).body.data).toEqual({
      granted: false, supervisor_ktu: true, supervised_brigades: 3, team_salary: false, managed_departments: [],
    });
  });

  it('ошибка базы у второй галочки — 500', async () => {
    h.loadKtu.mockRejectedValue(new Error('db down'));
    expect((await get()).statusCode).toBe(500);
  });

  it('некорректный id — 400, нет сотрудника — 404, вне зоны — 403, галочка не читается', async () => {
    expect((await get('abc')).statusCode).toBe(400);
    expect((await get(404404)).statusCode).toBe(404);
    h.canAccess.mockResolvedValue(false);
    expect((await get()).statusCode).toBe(403);
    expect(h.load).not.toHaveBeenCalled();
  });

  it('ошибка базы — 500, а не «нет доступа»: панель не затрёт неизвестное значение', async () => {
    h.load.mockRejectedValue(new Error('db down'));
    expect((await get()).statusCode).toBe(500);
  });
});

describe('PUT /admin/employees/:id/brigade-output-access', () => {
  it('поставить: аудит в той же транзакции, сотруднику — обновление профиля', async () => {
    const res = await put({ granted: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toEqual({ granted: true, supervisor_ktu: false, team_salary: false });
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'admin-user', 'EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED',
      expect.objectContaining({ entityId: String(EMPLOYEE), details: expect.objectContaining({ granted: true }) }),
    );
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
  });

  it('без изменений — ни аудита, ни оповещения', async () => {
    h.set.mockResolvedValue(false);
    expect((await put({ granted: true })).statusCode).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('выдать вне зоны — 403 без записи; снять можно и вне зоны', async () => {
    h.canWrite.mockResolvedValue(false);
    expect((await put({ granted: true })).statusCode).toBe(403);
    expect(h.set).not.toHaveBeenCalled();
    expect((await put({ granted: false })).statusCode).toBe(200);
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, false, 'admin-user');
  });

  it('некорректные id и тело — 400, нет сотрудника — 404', async () => {
    expect((await put({ granted: true }, 'abc')).statusCode).toBe(400);
    expect((await put({ granted: 'yes' })).statusCode).toBe(400);
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ granted: true }, 404404)).statusCode).toBe(404);
    expect(h.set).not.toHaveBeenCalled();
  });

  it('сбой оповещения не превращает сохранение в ошибку', async () => {
    h.query.mockRejectedValue(new Error('io down'));
    expect((await put({ granted: true })).statusCode).toBe(200);
  });
});

describe('PUT — галочка «Ставить КТУ своим бригадам» (370)', () => {
  it('старый фронт шлёт только granted — вторая галочка не трогается', async () => {
    h.loadKtu.mockResolvedValue(true);
    const res = await put({ granted: false });
    expect(res.statusCode).toBe(200);
    expect(h.setKtu).not.toHaveBeenCalled();
    expect(h.setTeam).not.toHaveBeenCalled();
    expect(res.body.data).toEqual({ granted: false, supervisor_ktu: true, team_salary: false });
  });

  it('поставить начальнику участка: запись и аудит в той же транзакции, обновление профиля', async () => {
    h.supervised.mockResolvedValue(['b-1']);
    const res = await put({ supervisor_ktu: true });
    expect(res.statusCode).toBe(200);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setKtu).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'admin-user', 'EMPLOYEE_SUPERVISOR_KTU_ACCESS_CHANGED',
      expect.objectContaining({ entityId: String(EMPLOYEE), details: expect.objectContaining({ granted: true }) }),
    );
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
    expect(res.body.data).toEqual({ granted: false, supervisor_ktu: true, team_salary: false });
  });

  it('не начальник ни одной бригады — 400 без записи; уже стоящую (спящую) — без ошибки', async () => {
    const res = await put({ supervisor_ktu: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('NOT_BRIGADE_SUPERVISOR');
    expect(h.setKtu).not.toHaveBeenCalled();
    h.loadKtu.mockResolvedValue(true);
    h.setKtu.mockResolvedValue(false);
    expect((await put({ supervisor_ktu: true })).statusCode).toBe(200);
  });

  it('выдать вне зоны — 403; снять — и вне зоны, и без бригад', async () => {
    h.supervised.mockResolvedValue(['b-1']);
    h.canWrite.mockResolvedValue(false);
    expect((await put({ supervisor_ktu: true })).statusCode).toBe(403);
    expect(h.setKtu).not.toHaveBeenCalled();
    h.supervised.mockResolvedValue([]);
    expect((await put({ supervisor_ktu: false })).statusCode).toBe(200);
    expect(h.setKtu).toHaveBeenCalledWith(h.client, EMPLOYEE, false, 'admin-user');
  });

  it('обе галочки — одной транзакцией, два аудита', async () => {
    h.supervised.mockResolvedValue(['b-1']);
    expect((await put({ granted: true, supervisor_ktu: true })).statusCode).toBe(200);
    expect(h.set).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.setKtu).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.audit.mock.calls.map(call => call[3])).toEqual([
      'EMPLOYEE_BRIGADE_OUTPUT_ACCESS_CHANGED', 'EMPLOYEE_SUPERVISOR_KTU_ACCESS_CHANGED',
    ]);
  });

  it('некорректное значение — 400', async () => {
    expect((await put({ supervisor_ktu: 'yes' })).statusCode).toBe(400);
  });
});

describe('«Видеть зарплату своих сотрудников в табеле» (382)', () => {
  it('GET: галочка и названия отделов руководителя', async () => {
    h.loadTeam.mockResolvedValue(true);
    h.managed.mockResolvedValue(['Гарантийный отдел', 'Сметно-технический']);
    expect((await get()).body.data).toEqual({
      granted: false,
      supervisor_ktu: false,
      supervised_brigades: 0,
      team_salary: true,
      managed_departments: ['Гарантийный отдел', 'Сметно-технический'],
    });
  });

  it('ошибка базы у третьей галочки — 500', async () => {
    h.loadTeam.mockRejectedValue(new Error('db down'));
    expect((await get()).statusCode).toBe(500);
  });

  it('поставить руководителю: запись и аудит в той же транзакции, обновление профиля; другие галочки не трогаются', async () => {
    h.managed.mockResolvedValue(['Гарантийный отдел']);
    const res = await put({ team_salary: true });
    expect(res.statusCode).toBe(200);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.setKtu).not.toHaveBeenCalled();
    expect(h.setTeam).toHaveBeenCalledWith(h.client, EMPLOYEE, true, 'admin-user');
    expect(h.audit).toHaveBeenCalledWith(
      h.client, expect.anything(), 'admin-user', 'EMPLOYEE_TEAM_SALARY_ACCESS_CHANGED',
      expect.objectContaining({ entityId: String(EMPLOYEE), details: expect.objectContaining({ granted: true }) }),
    );
    expect(h.emit).toHaveBeenCalledWith('profile:access_changed');
    expect(res.body.data).toEqual({ granted: false, supervisor_ktu: false, team_salary: true });
  });

  it('не руководитель ни одного отдела — 400 без записи; уже стоящую (спящую) — без ошибки', async () => {
    const res = await put({ team_salary: true });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('NOT_DEPARTMENT_MANAGER');
    expect(h.setTeam).not.toHaveBeenCalled();
    h.loadTeam.mockResolvedValue(true);
    h.setTeam.mockResolvedValue(false);
    expect((await put({ team_salary: true })).statusCode).toBe(200);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('выдать вне зоны — 403; снять — и вне зоны, и без отделов', async () => {
    h.managed.mockResolvedValue(['Гарантийный отдел']);
    h.canWrite.mockResolvedValue(false);
    expect((await put({ team_salary: true })).statusCode).toBe(403);
    expect(h.setTeam).not.toHaveBeenCalled();
    h.managed.mockResolvedValue([]);
    expect((await put({ team_salary: false })).statusCode).toBe(200);
    expect(h.setTeam).toHaveBeenCalledWith(h.client, EMPLOYEE, false, 'admin-user');
  });

  it('некорректное значение — 400', async () => {
    expect((await put({ team_salary: 'yes' })).statusCode).toBe(400);
    expect(h.setTeam).not.toHaveBeenCalled();
  });
});
