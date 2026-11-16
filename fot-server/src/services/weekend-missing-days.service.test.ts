import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('./timesheet-approval-correction-validation.service.js', () => ({ validateCorrectionAttachments: h.validate }));

const { filterWeekendMissingForGrid, listWeekendMissingDays } = await import('./weekend-missing-days.service.js');

const RANGE = { startDate: '2026-11-01', endDate: '2026-11-30' };

beforeEach(() => {
  h.validate.mockReset();
});

describe('listWeekendMissingDays', () => {
  it('проверка «по людям» с проходом без часов; только выходные, признак «без часов»', async () => {
    h.validate.mockResolvedValue({
      ok: false,
      missing: [
        { date: '2026-11-07', employee_id: 1, employee_name: null, kind: 'weekend_no_correction', reason: '', without_hours: true },
        { date: '2026-11-08', employee_id: 1, employee_name: null, kind: 'weekend_no_correction', reason: '' },
        { date: '2026-11-03', employee_id: 1, employee_name: null, kind: 'leave_request', reason: '' },
      ],
    });

    expect(await listWeekendMissingDays([1, 2], RANGE)).toEqual([
      { employee_id: 1, date: '2026-11-07', without_hours: true },
      { employee_id: 1, date: '2026-11-08', without_hours: false },
    ]);
    expect(h.validate).toHaveBeenCalledWith({ kind: 'personal', employeeIds: [1, 2] }, RANGE, { includePassWithoutHours: true });
  });

  it('проверка прошла — пусто; людей нет — без проверки', async () => {
    h.validate.mockResolvedValue({ ok: true });
    expect(await listWeekendMissingDays([1], RANGE)).toEqual([]);

    h.validate.mockClear();
    expect(await listWeekendMissingDays([], RANGE)).toEqual([]);
    expect(h.validate).not.toHaveBeenCalled();
  });
});

describe('filterWeekendMissingForGrid', () => {
  const day = (employeeId: number, date: string) => ({ employee_id: employeeId, date, without_hours: false });

  it('только люди сетки, только диапазон сетки и не раньше 01.11.2026', () => {
    const days = [day(1, '2026-10-31'), day(1, '2026-11-07'), day(1, '2026-11-29'), day(9, '2026-11-07')];
    expect(filterWeekendMissingForGrid(days, [{ id: 1 }], '2026-10-01', '2026-11-15')).toEqual([day(1, '2026-11-07')]);
  });

  it('окно строки: с даты перевода или исключения (что раньше) — вне, до даты входа — вне', () => {
    const days = [day(1, '2026-11-07'), day(1, '2026-11-14'), day(1, '2026-11-21'), day(1, '2026-11-28')];
    const employee = {
      id: '1', joined_date: '2026-11-10', transferred_out_date: '2026-11-25', excluded_from_timesheet_date: '2026-11-21',
    };
    expect(filterWeekendMissingForGrid(days, [employee], '2026-11-01', '2026-11-30')).toEqual([day(1, '2026-11-14')]);
  });
});
