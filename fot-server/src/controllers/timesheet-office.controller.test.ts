import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Окно «Режим табелирования» (291): форма запроса и ответы об ошибках. */

const h = vi.hoisted(() => ({
  getState: vi.fn(),
  search: vi.fn(),
  members: vi.fn(),
  employee: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../services/timesheet-office.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/timesheet-office.service.js')>()),
  updateTimesheetOffice: h.update,
}));
vi.mock('../services/timesheet-office-read.service.js', () => ({
  getTimesheetOfficeState: h.getState,
  searchTimesheetOfficeEmployees: h.search,
  getTimesheetOfficeDepartmentMembers: h.members,
  getTimesheetOfficeEmployee: h.employee,
}));

const { timesheetOfficeController } = await import('./timesheet-office.controller.js');
const { TimesheetOfficeError } = await import('../services/timesheet-office.service.js');

const DEPT = '11111111-1111-4111-8111-111111111111';

function mockRes() {
  const res = { statusCode: 200, body: undefined as unknown, status: vi.fn(), json: vi.fn() };
  res.status.mockImplementation((code: number) => { res.statusCode = code; return res; });
  res.json.mockImplementation((body: unknown) => { res.body = body; return res; });
  return res;
}

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
});

describe('timesheetOfficeController.update', () => {
  it('списки по умолчанию пустые; id без дублей — дело сервиса', async () => {
    h.update.mockResolvedValue({ changed: true });
    const res = mockRes();
    await timesheetOfficeController.update({ body: { departments: { add: [DEPT] } } } as never, res as never);
    expect(h.update).toHaveBeenCalledWith(expect.anything(), {
      departments: { add: [DEPT], remove: [] },
      employees: { add: [], remove: [] },
    });
    expect(res.body).toEqual({ success: true, changed: true, data: { changed: true } });
  });

  it('не uuid, не число или больше 500 — 400 без вызова сервиса', async () => {
    for (const body of [
      { departments: { add: ['not-uuid'] } },
      { employees: { add: ['5'] } },
      { employees: { add: Array.from({ length: 501 }, (_, index) => index + 1) } },
    ]) {
      const res = mockRes();
      await timesheetOfficeController.update({ body } as never, res as never);
      expect(res.statusCode).toBe(400);
    }
    expect(h.update).not.toHaveBeenCalled();
  });

  it('ошибка сервиса — её статус, код и подробности', async () => {
    h.update.mockRejectedValue(new TimesheetOfficeError(409, 'TIMESHEET_OFFICE_CHANGED', 'Состав изменился — обновите окно', [7]));
    const res = mockRes();
    await timesheetOfficeController.update({ body: { employees: { add: [7] } } } as never, res as never);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      success: false, code: 'TIMESHEET_OFFICE_CHANGED', error: 'Состав изменился — обновите окно', details: [7],
    });
  });

  it('неизвестная ошибка — 500 без подробностей', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.update.mockRejectedValue(new Error('boom'));
    const res = mockRes();
    await timesheetOfficeController.update({ body: { employees: { add: [7] } } } as never, res as never);
    expect(res.statusCode).toBe(500);
  });
});

describe('timesheetOfficeController.searchEmployees', () => {
  it('поиск из query-строки', async () => {
    h.search.mockResolvedValue([]);
    const res = mockRes();
    await timesheetOfficeController.searchEmployees({ query: { search: ' Семёнов ' } } as never, res as never);
    expect(h.search).toHaveBeenCalledWith(expect.anything(), 'Семёнов');
    expect(res.body).toEqual({ success: true, data: [] });
  });
});

describe('timesheetOfficeController.getDepartmentMembers', () => {
  it('id не uuid — 400 без вызова сервиса; иначе — данные сервиса', async () => {
    const bad = mockRes();
    await timesheetOfficeController.getDepartmentMembers({ params: { id: 'abc' } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
    expect(h.members).not.toHaveBeenCalled();

    h.members.mockResolvedValue({ office: false, employees: [] });
    const res = mockRes();
    await timesheetOfficeController.getDepartmentMembers({ params: { id: DEPT } } as never, res as never);
    expect(h.members).toHaveBeenCalledWith(expect.anything(), DEPT);
    expect(res.body).toEqual({ success: true, data: { office: false, employees: [] } });
  });

  it('ошибка сервиса — её статус и код', async () => {
    h.members.mockRejectedValue(new TimesheetOfficeError(403, 'TIMESHEET_OFFICE_FORBIDDEN', 'Отдел вне вашего доступа'));
    const res = mockRes();
    await timesheetOfficeController.getDepartmentMembers({ params: { id: DEPT } } as never, res as never);
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'TIMESHEET_OFFICE_FORBIDDEN' });
  });
});

describe('timesheetOfficeController.getEmployee', () => {
  it('id не целое положительное — 400 без вызова сервиса; иначе — число в сервис', async () => {
    for (const id of ['abc', '0', '1.5']) {
      const bad = mockRes();
      await timesheetOfficeController.getEmployee({ params: { id } } as never, bad as never);
      expect(bad.statusCode).toBe(400);
    }
    expect(h.employee).not.toHaveBeenCalled();

    h.employee.mockResolvedValue({ id: 60 });
    const res = mockRes();
    await timesheetOfficeController.getEmployee({ params: { id: '60' } } as never, res as never);
    expect(h.employee).toHaveBeenCalledWith(expect.anything(), 60);
    expect(res.body).toEqual({ success: true, data: { id: 60 } });
  });
});
