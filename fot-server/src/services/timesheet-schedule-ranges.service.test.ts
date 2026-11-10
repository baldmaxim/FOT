import { describe, expect, it, vi } from 'vitest';

// Периоды «По графику» (миграция 358): обрезка датой приёма и увольнения, попадание дня.

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: h.query }));

const {
  clipScheduleRange,
  isScheduleBasedDate,
  loadScheduleBasedRanges,
  shiftIsoDay,
} = await import('./timesheet-schedule-ranges.service.js');

describe('clipScheduleRange', () => {
  it('без приёма и увольнения — как в строке', () => {
    expect(clipScheduleRange({ date_from: '2026-11-01', date_to: null, hire_date: null, dismissal_date: null }))
      .toEqual({ from: '2026-11-01', to: null });
  });

  it('принят 15.11 после отметки с 01.11 — с 15.11', () => {
    expect(clipScheduleRange({ date_from: '2026-11-01', date_to: null, hire_date: '2026-11-15', dismissal_date: null }))
      .toEqual({ from: '2026-11-15', to: null });
  });

  it('уволен 20.11 — по 20.11; закрытый раньше период — по своей дате', () => {
    expect(clipScheduleRange({ date_from: '2026-11-01', date_to: null, hire_date: '2020-01-01', dismissal_date: '2026-11-20' }))
      .toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(clipScheduleRange({ date_from: '2026-11-01', date_to: '2026-11-15', hire_date: null, dismissal_date: '2026-11-20' }))
      .toEqual({ from: '2026-11-01', to: '2026-11-15' });
  });

  it('уволен до начала периода — ничего', () => {
    expect(clipScheduleRange({ date_from: '2026-11-16', date_to: null, hire_date: null, dismissal_date: '2026-11-05' }))
      .toBeNull();
  });
});

describe('isScheduleBasedDate', () => {
  const ranges = new Map([[1, [{ from: '2026-10-01', to: '2026-10-31' }, { from: '2026-11-16', to: null }]]]);

  it('границы включительно, разрыв между периодами — нет', () => {
    expect(isScheduleBasedDate(ranges, 1, '2026-10-01')).toBe(true);
    expect(isScheduleBasedDate(ranges, 1, '2026-10-31')).toBe(true);
    expect(isScheduleBasedDate(ranges, 1, '2026-11-01')).toBe(false);
    expect(isScheduleBasedDate(ranges, 1, '2026-11-15')).toBe(false);
    expect(isScheduleBasedDate(ranges, 1, '2026-11-16')).toBe(true);
    expect(isScheduleBasedDate(ranges, 1, '2027-03-01')).toBe(true);
    expect(isScheduleBasedDate(ranges, 2, '2026-11-20')).toBe(false);
  });
});

describe('loadScheduleBasedRanges', () => {
  it('пустой список — без запроса', async () => {
    expect((await loadScheduleBasedRanges([], '2026-11-01', '2026-11-30')).size).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('периоды по сотрудникам, пустые после обрезки — отброшены', async () => {
    h.query.mockResolvedValue([
      { employee_id: 1, date_from: '2026-11-01', date_to: null, hire_date: null, dismissal_date: null },
      { employee_id: 2, date_from: '2026-11-16', date_to: null, hire_date: null, dismissal_date: '2026-11-05' },
    ]);
    const ranges = await loadScheduleBasedRanges([1, 2], '2026-11-01', '2026-11-30');
    expect([...ranges.entries()]).toEqual([[1, [{ from: '2026-11-01', to: null }]]]);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM employee_schedule_timesheet_periods p');
    expect(params).toEqual([[1, 2], '2026-11-01', '2026-11-30']);
  });

  it('через клиент транзакции, если передан', async () => {
    const exec = { query: vi.fn(async () => ({ rows: [] })) };
    await loadScheduleBasedRanges([3], '2026-11-01', '2026-11-30', exec as never);
    expect(exec.query).toHaveBeenCalledTimes(1);
  });
});

describe('shiftIsoDay', () => {
  it('через границу месяца и года', () => {
    expect(shiftIsoDay('2026-11-01', -1)).toBe('2026-10-31');
    expect(shiftIsoDay('2026-12-31', 1)).toBe('2027-01-01');
  });
});
