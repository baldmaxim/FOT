import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('./timesheet-approval-correction-validation.service.js', () => ({ validateCorrectionAttachments: h.validate }));

const { listWeekendMissingDays } = await import('./weekend-missing-days.service.js');

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
