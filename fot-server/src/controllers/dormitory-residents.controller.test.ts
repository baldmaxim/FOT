import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const svc = vi.hoisted(() => ({
  getStay: vi.fn(),
  listStaysOfClass: vi.fn(),
  updateStayMeta: vi.fn(),
  getEmployeeState: vi.fn(),
}));
vi.mock('../services/dormitory-stays.service.js', () => svc);

const residentsSvc = vi.hoisted(() => ({
  loadPassports: vi.fn(),
  loadLastPasses: vi.fn(),
  loadSupervisorLabels: vi.fn(),
}));
vi.mock('../services/dormitory-residents.service.js', () => residentsSvc);

const moveSvc = vi.hoisted(() => ({ moveStay: vi.fn() }));
vi.mock('../services/dormitory-stay-move.service.js', () => moveSvc);

const compensationSvc = vi.hoisted(() => ({ listCompensationMonth: vi.fn() }));
vi.mock('../services/dormitory-compensation.service.js', () => compensationSvc);

// «Обновление документов» компенсации (миграция 380).
const pauseSvc = vi.hoisted(() => ({
  updateCompensationDocs: vi.fn(),
  suspendCompensation: vi.fn(),
  resumeCompensation: vi.fn(),
  finishCompensationPause: vi.fn(),
}));
vi.mock('../services/dormitory-compensation-pause.service.js', () => pauseSvc);

const scope = vi.hoisted(() => ({
  canWriteEmployeeInScope: vi.fn(),
  canSeeEmployeeInStaffList: vi.fn(),
  resolveStaffRosterEmployeeIds: vi.fn(),
}));
vi.mock('../services/data-scope.service.js', () => ({ canWriteEmployeeInScope: scope.canWriteEmployeeInScope }));
vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: scope.canSeeEmployeeInStaffList,
  resolveStaffRosterEmployeeIds: scope.resolveStaffRosterEmployeeIds,
}));

const audit = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../services/audit.service.js', () => ({ auditService: audit }));

const grant = vi.hoisted(() => ({ getRequestStaffTabGrant: vi.fn() }));
vi.mock('../services/staff-tab-access.service.js', () => grant);

// Полный паспорт — с правом правки «Реквизитов» или «Проживания».
const pageAccess = vi.hoisted(() => ({ resolveEffectivePageAccess: vi.fn() }));
vi.mock('../services/access-control.service.js', () => pageAccess);

const today = vi.hoisted(() => ({ value: '2026-11-19' }));
vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: () => today.value }));

import { dormitoryResidentsController as c } from './dormitory-residents.controller.js';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (over: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest => ({
  user: { id: 'user-1' }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const STAY = {
  id: 7, employee_id: 42, full_name: 'Баратов Илёс Шералиевич', department: 'Участок электромонтажных работ',
  position: 'Электрик', kind: 'dormitory', check_in: '2026-09-01', check_out: null, address: 'Общ. Верхнелихоборская 6',
  amount: null, apartment_id: null, paid: false, comment: null, updated_at: '2026-10-30T10:00:00Z',
  employment_status: 'active', dismissal_date: null, org_department_id: 'dep-1', country: 'УЗБЕКИСТАН',
};
const FLAT = { ...STAY, id: 8, employee_id: 43, apartment_id: 2, address: 'Кв. Ляпидевского 12-58' };

beforeEach(() => {
  vi.clearAllMocks();
  today.value = '2026-11-19';
  grant.getRequestStaffTabGrant.mockResolvedValue(false);
  scope.resolveStaffRosterEmployeeIds.mockResolvedValue(new Set([42, 43]));
  scope.canWriteEmployeeInScope.mockResolvedValue(true);
  residentsSvc.loadPassports.mockResolvedValue(new Map([[42, '•••••6451']]));
  pageAccess.resolveEffectivePageAccess.mockResolvedValue(false);
  residentsSvc.loadLastPasses.mockResolvedValue(new Map([[42, { at: '2026-11-19T06:17:13', access_point: 'Сити Bay (3)' }]]));
  residentsSvc.loadSupervisorLabels.mockResolvedValue(new Map([[42, 'Колбухов Д. Н.']]));
});

describe('«Общежитие» — жильцы', () => {
  it('охват списка кадров; без месяца — текущий: сведения у записей месяца, у прошлых — нет', async () => {
    const past = { ...STAY, id: 9, employee_id: 44, check_in: '2026-09-01', check_out: '2026-10-20' };
    svc.listStaysOfClass.mockResolvedValue([STAY, past]);
    const res = makeRes();
    await c.residents(makeReq(), res);
    expect(svc.listStaysOfClass).toHaveBeenCalledWith('dormitory', [42, 43]);
    // Ни правки «Реквизитов», ни правки «Проживания» — последние 4 знака.
    expect(pageAccess.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/staff-control/hr-profiles', 'edit');
    expect(pageAccess.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/staff-control/dormitory', 'edit');
    expect(residentsSvc.loadPassports).toHaveBeenCalledWith([42], { full: false });
    expect(residentsSvc.loadLastPasses).toHaveBeenCalledWith([42], '2026-11-19');
    expect(residentsSvc.loadSupervisorLabels).toHaveBeenCalledWith([{ employee_id: 42, org_department_id: 'dep-1' }]);
    expect(res.body.data).toEqual({
      today: '2026-11-19',
      residents: [
        { ...STAY, passport: '•••••6451', last_pass_at: '2026-11-19T06:17:13', last_access_point: 'Сити Bay (3)', supervisor: 'Колбухов Д. Н.' },
        { ...past, passport: null, last_pass_at: null, last_access_point: null, supervisor: null },
      ],
    });
  });

  it('прошлый месяц: сведения у живших в нём, крайний проход — до конца месяца; право «Реквизитов» — полный паспорт', async () => {
    const past = { ...STAY, id: 9, employee_id: 44, check_in: '2026-09-01', check_out: '2026-10-20' };
    const later = { ...STAY, id: 11, employee_id: 45, check_in: '2026-11-05' };
    svc.listStaysOfClass.mockResolvedValue([STAY, past, later]);
    pageAccess.resolveEffectivePageAccess.mockResolvedValue(true);
    await c.residents(makeReq({ query: { month: '2026-10' } }), makeRes());
    // Право «Реквизитов» решает само — правку «Проживания» не спрашиваем.
    expect(pageAccess.resolveEffectivePageAccess).toHaveBeenCalledTimes(1);
    expect(pageAccess.resolveEffectivePageAccess).toHaveBeenCalledWith(expect.anything(), '/staff-control/hr-profiles', 'edit');
    expect(residentsSvc.loadPassports).toHaveBeenCalledWith([42, 44], { full: true });
    expect(residentsSvc.loadLastPasses).toHaveBeenCalledWith([42, 44], '2026-10-31');

    const bad = makeRes();
    await c.residents(makeReq({ query: { month: '2026-13' } }), bad);
    expect(bad.statusCode).toBe(400);
  });

  it('правка «Проживания» без правки «Реквизитов» — полный паспорт (роль «Учёт проживания», личная галочка)', async () => {
    svc.listStaysOfClass.mockResolvedValue([STAY]);
    pageAccess.resolveEffectivePageAccess.mockImplementation(async (_req: unknown, page: string, action: string) => (
      page === '/staff-control/dormitory' && action === 'edit'
    ));
    await c.residents(makeReq(), makeRes());
    expect(residentsSvc.loadPassports).toHaveBeenCalledWith([42], { full: true });
  });

  it('галочка «Проживание» — вся организация', async () => {
    grant.getRequestStaffTabGrant.mockResolvedValue(true);
    svc.listStaysOfClass.mockResolvedValue([]);
    await c.residents(makeReq(), makeRes());
    expect(svc.listStaysOfClass).toHaveBeenCalledWith('dormitory', null);
    expect(scope.resolveStaffRosterEmployeeIds).not.toHaveBeenCalled();
  });
});

describe('«Платно» и комментарий', () => {
  it('изменилось — в аудит было → стало; без изменений — без аудита', async () => {
    svc.getStay.mockResolvedValue(FLAT);
    svc.updateStayMeta.mockResolvedValue({ before: FLAT, after: { ...FLAT, paid: true } });
    const res = makeRes();
    await c.updateMeta(makeReq({ params: { id: '8' }, body: { paid: true } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.updateStayMeta).toHaveBeenCalledWith(8, { paid: true });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED', expect.objectContaining({
      details: { from: expect.objectContaining({ paid: false }), to: expect.objectContaining({ paid: true }) },
    }));

    audit.logFromRequest.mockClear();
    svc.updateStayMeta.mockResolvedValue({ before: FLAT, after: FLAT });
    await c.updateMeta(makeReq({ params: { id: '8' }, body: { comment: '  ' } }), makeRes());
    expect(svc.updateStayMeta).toHaveBeenLastCalledWith(8, { comment: null });
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('«Платно» у общежития — 400; пусто, лишнее поле, длинный комментарий — 400; чужой — 403; нет — 404', async () => {
    svc.getStay.mockResolvedValue(STAY);
    svc.updateStayMeta.mockResolvedValue('not_flat');
    const notFlat = makeRes();
    await c.updateMeta(makeReq({ params: { id: '7' }, body: { paid: true } }), notFlat);
    expect(notFlat.statusCode).toBe(400);

    for (const bad of [{}, { address: 'Общ. Свободы 35' }, { paid: 'да' }, { comment: 'к'.repeat(501) }]) {
      const res = makeRes();
      await c.updateMeta(makeReq({ params: { id: '7' }, body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }

    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    const foreign = makeRes();
    await c.updateMeta(makeReq({ params: { id: '7' }, body: { comment: 'x' } }), foreign);
    expect(foreign.statusCode).toBe(403);

    svc.getStay.mockResolvedValue(null);
    const missing = makeRes();
    await c.updateMeta(makeReq({ params: { id: '99' }, body: { comment: 'x' } }), missing);
    expect(missing.statusCode).toBe(404);
  });
});

describe('«Обновление документов» компенсации (миграция 380)', () => {
  const COMPENSATION = { ...STAY, id: 18, employee_id: 42, kind: 'apartment', address: null, amount: '630.00', docs_updated_on: null };
  const PAUSED = { ...COMPENSATION, check_out: '2026-11-16', suspended: true };

  it('дата не раньше паузы — компенсация возобновлена: data — запись, resumed — новая; аудит обоих', async () => {
    today.value = '2026-11-26';
    svc.getStay.mockResolvedValue(PAUSED);
    const resumed = { ...COMPENSATION, id: 500, check_in: '2026-11-20', docs_updated_on: '2026-11-20', resumed_from_id: 18 };
    pauseSvc.updateCompensationDocs.mockResolvedValue({
      before: PAUSED, after: { ...PAUSED, docs_updated_on: '2026-11-20' }, resumed, pauseCancelled: false,
    });
    const res = makeRes();
    await c.updateMeta(makeReq({ params: { id: '18' }, body: { docs_updated_on: '2026-11-20' } }), res);

    expect(res.statusCode).toBe(200);
    expect(pauseSvc.updateCompensationDocs).toHaveBeenCalledWith(18, '2026-11-20', '2026-11-01', '2026-11-26');
    expect(svc.updateStayMeta).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: expect.objectContaining({ id: 18, docs_updated_on: '2026-11-20' }), resumed });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_STAY_UPDATED', expect.objectContaining({
      details: expect.objectContaining({ action: 'docs', to: expect.objectContaining({ docs_updated_on: '2026-11-20' }) }),
    }));
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'DORMITORY_STAY_ADDED', expect.objectContaining({
      entityId: '500', details: expect.objectContaining({ action: 'resume', reason: 'docs' }),
    }));
  });

  it('1–10 декабря — открыт и ноябрь: граница 01.11; комментарий и дата — обе правки', async () => {
    today.value = '2026-12-05';
    svc.getStay.mockResolvedValue(COMPENSATION);
    svc.updateStayMeta.mockResolvedValue({ before: COMPENSATION, after: { ...COMPENSATION, comment: 'НЕТ обновления' } });
    pauseSvc.updateCompensationDocs.mockResolvedValue({
      before: COMPENSATION, after: COMPENSATION, resumed: null, pauseCancelled: false,
    });
    const res = makeRes();
    await c.updateMeta(makeReq({ params: { id: '18' }, body: { comment: 'НЕТ обновления', docs_updated_on: null } }), res);
    expect(res.statusCode).toBe(200);
    expect(svc.updateStayMeta).toHaveBeenCalledWith(18, { comment: 'НЕТ обновления' });
    expect(pauseSvc.updateCompensationDocs).toHaveBeenCalledWith(18, null, '2026-11-01', '2026-12-05');
    expect(res.body.resumed).toBeNull();
  });

  it('у общежития — 400; неверная дата — 400; только комментарий — resumed null (прежний формат data)', async () => {
    svc.getStay.mockResolvedValue(STAY);
    const dormitory = makeRes();
    await c.updateMeta(makeReq({ params: { id: '7' }, body: { docs_updated_on: '2026-11-20' } }), dormitory);
    expect(dormitory.statusCode).toBe(400);

    svc.getStay.mockResolvedValue(COMPENSATION);
    const bad = makeRes();
    await c.updateMeta(makeReq({ params: { id: '18' }, body: { docs_updated_on: '2026-02-31' } }), bad);
    expect(bad.statusCode).toBe(400);
    expect(pauseSvc.updateCompensationDocs).not.toHaveBeenCalled();

    svc.updateStayMeta.mockResolvedValue({ before: COMPENSATION, after: { ...COMPENSATION, comment: 'x' } });
    const comment = makeRes();
    await c.updateMeta(makeReq({ params: { id: '18' }, body: { comment: 'x' } }), comment);
    expect(comment.body).toEqual({ success: true, data: expect.objectContaining({ id: 18, comment: 'x' }), resumed: null });
  });

  it('пересечение при возобновлении — 409 текстом', async () => {
    svc.getStay.mockResolvedValue(PAUSED);
    pauseSvc.updateCompensationDocs.mockResolvedValue('overlap');
    const res = makeRes();
    await c.updateMeta(makeReq({ params: { id: '18' }, body: { docs_updated_on: '2026-11-20' } }), res);
    expect(res.statusCode).toBe(409);
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('«Переселить»', () => {
  const opened = { ...STAY, id: 10, check_in: '2026-11-19', address: 'Общ. Свободы 35' };
  const closed = { ...STAY, check_out: '2026-11-19' };

  it('переселён — два события аудита с общим move_id; повтор — без аудита', async () => {
    svc.getStay.mockResolvedValue(STAY);
    moveSvc.moveStay.mockResolvedValue({ closed, opened, repeated: false });
    const res = makeRes();
    await c.move(makeReq({ params: { id: '7' }, body: { date: '2026-11-19', address: ' Общ.  Свободы 35 ' } }), res);
    expect(res.statusCode).toBe(200);
    expect(moveSvc.moveStay).toHaveBeenCalledWith(7, '2026-11-19', { address: 'Общ. Свободы 35' }, null);
    expect(audit.logFromRequest).toHaveBeenCalledTimes(2);
    const [first, second] = audit.logFromRequest.mock.calls.map(call => call[3] as { details: { move_id: string } });
    expect(first.details.move_id).toBe(second.details.move_id);
    expect(audit.logFromRequest.mock.calls.map(call => call[2])).toEqual(['DORMITORY_STAY_UPDATED', 'DORMITORY_STAY_ADDED']);

    audit.logFromRequest.mockClear();
    moveSvc.moveStay.mockResolvedValue({ closed, opened, repeated: true });
    await c.move(makeReq({ params: { id: '7' }, body: { date: '2026-11-19', apartment_id: 2, comment: ' по просьбе ' } }), makeRes());
    expect(moveSvc.moveStay).toHaveBeenLastCalledWith(7, '2026-11-19', { apartmentId: 2 }, 'по просьбе');
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });

  it('дата вне окна, оба или ни одного места, «Кв. …» адресом — 400 без записи; чужой — 403', async () => {
    svc.getStay.mockResolvedValue(STAY);
    for (const bad of [
      { date: '2026-10-31', address: 'Общ. Свободы 35' },
      { date: '2026-11-20', address: 'Общ. Свободы 35' },
      { date: '2026-11-19' },
      { date: '2026-11-19', address: 'Общ. Свободы 35', apartment_id: 2 },
      { date: '2026-11-19', address: 'Кв. Ляпидевского 12-58' },
      { date: '2026-02-30', address: 'Общ. Свободы 35' },
    ]) {
      const res = makeRes();
      await c.move(makeReq({ params: { id: '7' }, body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(moveSvc.moveStay).not.toHaveBeenCalled();

    scope.canWriteEmployeeInScope.mockResolvedValue(false);
    const foreign = makeRes();
    await c.move(makeReq({ params: { id: '7' }, body: { date: '2026-11-19', address: 'Общ. Свободы 35' } }), foreign);
    expect(foreign.statusCode).toBe(403);
  });

  it('ответы сервиса — понятной ошибкой', async () => {
    svc.getStay.mockResolvedValue(STAY);
    const cases: Array<[string, number]> = [
      ['same_place', 400], ['before_check_in', 400], ['not_open', 400], ['not_movable', 400],
      ['apartment_not_found', 404], ['not_found', 404], ['overlap', 409],
    ];
    for (const [result, status] of cases) {
      moveSvc.moveStay.mockResolvedValue(result);
      const res = makeRes();
      await c.move(makeReq({ params: { id: '7' }, body: { date: '2026-11-19', address: 'Общ. Свободы 35' } }), res);
      expect(res.statusCode, result).toBe(status);
      expect(res.body.error, result).toEqual(expect.any(String));
    }
    expect(audit.logFromRequest).not.toHaveBeenCalled();
  });
});

describe('«Компенсация аренды»', () => {
  it('месяц обязателен; охват — список кадров', async () => {
    for (const month of [undefined, '2026-13', '2026-1', 'всё']) {
      const res = makeRes();
      await c.compensation(makeReq({ query: { month } as never }), res);
      expect(res.statusCode, String(month)).toBe(400);
    }
    compensationSvc.listCompensationMonth.mockResolvedValue([]);
    const res = makeRes();
    const req = makeReq({ query: { month: '2026-10' } as never });
    await c.compensation(req, res);
    expect(res.statusCode).toBe(200);
    expect(compensationSvc.listCompensationMonth).toHaveBeenCalledWith([42, 43], '2026-10', req);
  });
});
