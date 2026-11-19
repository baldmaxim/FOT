import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const apartmentsSvc = vi.hoisted(() => ({
  listApartments: vi.fn(),
  addApartment: vi.fn(),
  updateApartment: vi.fn(),
  deleteApartment: vi.fn(),
}));
vi.mock('../services/company-apartments.service.js', () => apartmentsSvc);

const svc = vi.hoisted(() => ({ listStaysOfClass: vi.fn(), getEmployeeState: vi.fn() }));
vi.mock('../services/dormitory-stays.service.js', () => svc);

const residentsSvc = vi.hoisted(() => ({ loadPhones: vi.fn(), loadNearestVacations: vi.fn() }));
vi.mock('../services/dormitory-residents.service.js', () => residentsSvc);

const objects = vi.hoisted(() => ({ loadMainObjects: vi.fn() }));
vi.mock('../services/employee-main-object-snapshot.service.js', () => objects);
vi.mock('./employees-export.controller.js', () => ({
  resolveExportPeriod: () => ({ start: '2026-10-21', end: '2026-11-19' }),
}));

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
vi.mock('../utils/date.utils.js', () => ({ moscowTodayIso: () => '2026-11-19' }));

import { companyApartmentsController as c } from './company-apartments.controller.js';

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

const APARTMENT = {
  id: 2, address: 'Ляпидевского 12-58', note: 'семейная РФ', rooms: 2, places: 3, price: '70000.00', paid_until: '2026-12-25',
};
const RESIDENT = {
  id: 8, employee_id: 43, full_name: 'Гладкая Алина Романовна', department: 'Отдел табельного учёта', position: 'табельщик',
  kind: 'dormitory', check_in: '2024-08-01', check_out: null, address: 'Кв. Ляпидевского 12-58', amount: null,
  apartment_id: 2, paid: true, comment: null, updated_at: '2026-10-30T10:00:00Z', employment_status: 'active',
  dismissal_date: null, org_department_id: 'dep-1', country: 'РОССИЯ',
};
const BODY = { address: 'Ляпидевского 12-58', note: 'семейная РФ', rooms: 2, places: 3, price: 70000, paid_until: '2026-12-25' };

beforeEach(() => {
  vi.clearAllMocks();
  grant.getRequestStaffTabGrant.mockResolvedValue(false);
  scope.resolveStaffRosterEmployeeIds.mockResolvedValue(new Set([43]));
  residentsSvc.loadPhones.mockResolvedValue(new Map([[43, '79167126479']]));
  residentsSvc.loadNearestVacations.mockResolvedValue(new Map([[43, { from: '2026-12-10', to: '2026-12-23' }]]));
  objects.loadMainObjects.mockResolvedValue({ objects: new Map([[43, 'ЖК Ситибэй']]) });
});

describe('«Квартира» — список', () => {
  it('квартиры — все; жильцы — в охвате списка кадров; телефон, отпуск, объект — только у живущих', async () => {
    const past = { ...RESIDENT, id: 9, employee_id: 44, check_out: '2026-03-01', paid: false };
    apartmentsSvc.listApartments.mockResolvedValue([APARTMENT]);
    svc.listStaysOfClass.mockResolvedValue([RESIDENT, past]);
    const res = makeRes();
    await c.list(makeReq(), res);
    expect(svc.listStaysOfClass).toHaveBeenCalledWith('flat', [43]);
    expect(residentsSvc.loadPhones).toHaveBeenCalledWith([43]);
    expect(objects.loadMainObjects).toHaveBeenCalledWith([43], { start: '2026-10-21', end: '2026-11-19' });
    expect(res.body.data).toEqual({
      today: '2026-11-19',
      apartments: [APARTMENT],
      residents: [
        { ...RESIDENT, phone: '79167126479', vacation_from: '2026-12-10', vacation_to: '2026-12-23', main_object: 'ЖК Ситибэй' },
        { ...past, phone: null, vacation_from: null, vacation_to: null, main_object: null },
      ],
    });
  });
});

describe('«Квартира» — запись', () => {
  it('добавление: «Кв.» в начале адреса снимается, пустые поля — null, в аудит', async () => {
    apartmentsSvc.addApartment.mockResolvedValue(APARTMENT);
    const res = makeRes();
    await c.add(makeReq({ body: { address: ' Кв.  Ляпидевского 12-58 ', note: '  ', rooms: null } }), res);
    expect(res.statusCode).toBe(200);
    expect(apartmentsSvc.addApartment).toHaveBeenCalledWith({
      address: 'Ляпидевского 12-58', note: null, rooms: null, places: null, price: null, paid_until: null,
    });
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'COMPANY_APARTMENT_ADDED', expect.anything());
  });

  it('пустой адрес, кривые числа и дата, копейки сверх 2 знаков — 400 без записи; дубль адреса — 409', async () => {
    for (const bad of [
      { address: '  ' }, { address: 'Кв.' }, { ...BODY, rooms: 0 }, { ...BODY, places: 1.5 }, { ...BODY, price: -1 },
      { ...BODY, price: 100.555 }, { ...BODY, paid_until: '2026-02-30' }, { ...BODY, note: 'п'.repeat(101) },
    ]) {
      const res = makeRes();
      await c.add(makeReq({ body: bad }), res);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(apartmentsSvc.addApartment).not.toHaveBeenCalled();
    apartmentsSvc.addApartment.mockResolvedValue('duplicate');
    const res = makeRes();
    await c.add(makeReq({ body: BODY }), res);
    expect(res.statusCode).toBe(409);
  });

  it('правка: изменилось — аудит со счётом переадресованных проживаний; без изменений — без аудита; нет — 404', async () => {
    apartmentsSvc.updateApartment.mockResolvedValue({
      before: APARTMENT, after: { ...APARTMENT, address: 'Ляпидевского 12-58А' }, relinked: 2,
    });
    await c.update(makeReq({ params: { id: '2' }, body: { ...BODY, address: 'Ляпидевского 12-58А' } }), makeRes());
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'COMPANY_APARTMENT_UPDATED', expect.objectContaining({
      details: expect.objectContaining({ stays_readdressed: 2 }),
    }));

    audit.logFromRequest.mockClear();
    apartmentsSvc.updateApartment.mockResolvedValue({ before: APARTMENT, after: APARTMENT, relinked: 0 });
    await c.update(makeReq({ params: { id: '2' }, body: BODY }), makeRes());
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    apartmentsSvc.updateApartment.mockResolvedValue(null);
    const missing = makeRes();
    await c.update(makeReq({ params: { id: '2' }, body: BODY }), missing);
    expect(missing.statusCode).toBe(404);
  });

  it('удаление: с жильцами или историей — 409; без — удалена и в аудите', async () => {
    apartmentsSvc.deleteApartment.mockResolvedValue('has_stays');
    const busy = makeRes();
    await c.remove(makeReq({ params: { id: '2' } }), busy);
    expect(busy.statusCode).toBe(409);
    expect(audit.logFromRequest).not.toHaveBeenCalled();

    apartmentsSvc.deleteApartment.mockResolvedValue(APARTMENT);
    const res = makeRes();
    await c.remove(makeReq({ params: { id: '2' } }), res);
    expect(res.statusCode).toBe(200);
    expect(audit.logFromRequest).toHaveBeenCalledWith(expect.anything(), 'user-1', 'COMPANY_APARTMENT_DELETED', expect.anything());
  });
});
